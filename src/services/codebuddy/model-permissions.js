/**
 * 模型权限缓存
 *
 * 上游 `/v3/config` 只说明「这个客户端能看到哪些模型」，不说明「你的账号能不能调用」。
 * 免费账号能看见 `gpt-5.5`（标价 x3.31），真去调却回 `11158 model not allowed for user type`。
 * 客户端拿到这份列表后会去选，选了才报错，体验很差。
 *
 * 所以权限只能靠实测累积：每次探测/真实请求失败于「账号类型不支持」时记一笔，
 * `/v1/models` 就把这些模型过滤掉，客户端（CC Switch 等）只会看到真正能用的。
 *
 * 存 `.codebuddy/model-permissions.json`，按「账号文件名 + 模型 id」记录。
 * 用文件名而不是下标：下标会随账号增删平移（和 priorityOrder 同一个教训）。
 *
 * @module services/codebuddy/model-permissions
 */

import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {CODEBUDDY_CREDS_DIR} from './config.js';

const PERMISSIONS_FILE = 'model-permissions.json';

/**
 * 上游业务码 → 「这个模型对当前账号是什么状态」
 *
 * 这里要区分三件不同的事，之前混在一起是错的：
 *
 * 1. **权限**（`forbidden`）：套餐/授权决定的，短期内不会变。
 *    - `11158` `model not allowed for user type`
 *    - `11102` 且 message 含 `only available for authorized users`
 *
 * 2. **额度**（`quota`）：当天用量用完了，上游会自己恢复，不是「不可用」。
 *    - `6004`，message 里通常带重置时刻（如「将在 2026-10-22 20:05 重置」）
 *    这类**不该标成不可用**，最多提示「今日额度已用完」。
 *
 * 3. **模型本身不存在**（`missing`）：上游查不到这个模型，与账号无关。
 *    - `11102` 且 message 含 `service info not found`
 *    - `11133` 模型拒绝请求
 *    这类也不该算到「账号没权限」头上。
 */
const FORBIDDEN_CODES = new Set([11158, '11158']);
const QUOTA_CODES = new Set([6004, '6004']);
const MISSING_CODES = new Set([11133, '11133']);
/** 11102 两种含义都可能，靠 message 区分 */
const AMBIGUOUS_CODE = 11102;

/**
 * 额度类限制的缓存有效期
 *
 * 额度是「今天用完了」，第二天就恢复；但没必要精确到上游的重置时刻，
 * 30 分钟足够让用户重测一次看到变化，也不会让它长期挂在灰名单里。
 */
const QUOTA_TTL_MS = 30 * 60 * 1000;
/** 权限由套餐决定，缓存久一点，但用户随时可以重测覆盖 */
const FORBIDDEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 模型不存在：上游配置变更后可能恢复，缓存 1 天 */
const MISSING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 判断一个上游错误说明了什么
 * @param {Error} error - CodeBuddyApiError
 * @returns {{kind: null|'forbidden'|'quota'|'missing', code: any, reason: string}}
 */
export function classifyModelPermission(error) {
    if (!error) return {kind: null, code: null, reason: ''};
    const code = error.code;
    const message = String(error.message || '');

    if (FORBIDDEN_CODES.has(code)) {
        return {kind: 'forbidden', code, reason: '当前账号不支持这个模型（需要更高套餐或授权）'};
    }
    if (QUOTA_CODES.has(code)) {
        // 上游 message 里常带重置时刻（如「将在 2026-10-22 20:05:02 UTC+8 重置」），
        // 原样透出来比笼统说「额度用完」有用。
        // 时间部分可能带时区后缀（UTC+8 / GMT+8），所以用非贪婪匹配到「重置」为止。
        const reset = message.match(/将在\s*(.+?)\s*重置/);
        const reason = reset
            ? `今日额度已用完，${reset[1]} 重置`
            : '今日额度已用完，稍后会自动恢复';
        return {kind: 'quota', code, reason};
    }
    if (MISSING_CODES.has(code)) {
        return {kind: 'missing', code, reason: '上游没有这个模型（可能是配置变更）'};
    }
    if (code === AMBIGUOUS_CODE || code === String(AMBIGUOUS_CODE)) {
        // 11102 两种含义：权限不足 vs 模型不存在，靠 message 区分
        if (/only available for authorized users/i.test(message)) {
            return {kind: 'forbidden', code, reason: '当前账号不支持这个模型（需要更高套餐或授权）'};
        }
        if (/service info not found/i.test(message)) {
            return {kind: 'missing', code, reason: '上游没有这个模型（可能是配置变更）'};
        }
        // 认不出具体含义时按权限处理（更保守，不会误判成模型坏了）
        return {kind: 'forbidden', code, reason: '上游拒绝了这个模型'};
    }
    return {kind: null, code: null, reason: ''};
}

/**
 * 这类状态是否该在面板上标成「不可用」
 *
 * 额度用完**不算不可用**——那只是今天用超了，明天照常。
 * 标灰会让人以为模型坏了或者没权限，反而误导。
 * @param {string|null} kind
 * @returns {boolean}
 */
export function isUnavailableKind(kind) {
    return kind === 'forbidden' || kind === 'missing';
}

/**
 * 权限缓存
 *
 * 结构：`{version: 1, accounts: {"<filename>": {"<model>": {kind, code, reason, at, expiresAt, email, baseUrl}}}}`
 */
export class ModelPermissionStore {
    /**
     * @param {string} [dir] 存储目录，默认 `.codebuddy`
     */
    constructor(dir = join(process.cwd(), CODEBUDDY_CREDS_DIR)) {
        this.dir = dir;
        this.file = join(dir, PERMISSIONS_FILE);
        /** @type {Map<string, Map<string, Object>>} 账号 → (模型 → 记录) */
        this.accounts = new Map();
        this._loaded = false;
    }

    /**
     * 从磁盘加载（幂等）
     */
    load() {
        if (this._loaded) return this;
        this._loaded = true;
        if (!existsSync(this.file)) return this;

        try {
            const raw = JSON.parse(readFileSync(this.file, 'utf8'));
            const accounts = raw?.accounts || {};
            for (const [account, models] of Object.entries(accounts)) {
                const map = new Map();
                for (const [model, rec] of Object.entries(models || {})) {
                    if (rec && typeof rec === 'object') map.set(model, rec);
                }
                this.accounts.set(account, map);
            }
        } catch (err) {
            logger.warn(`[CodeBuddy] 模型权限缓存读取失败，按空处理: ${err.message}`);
        }
        return this;
    }

    /**
     * 记一笔「该模型对该账号不可用」
     *
     * @param {Object} params
     * @param {string} params.account - 凭证文件名
     * @param {string} params.model
     * @param {Object} params.error - 上游错误
     * @param {string} [params.email]
     * @param {string} [params.baseUrl]
     * @returns {boolean} 是否记录成功（不是权限/额度/模型缺失类错误时返回 false）
     */
    recordBlocked({account, model, error, email = '', baseUrl = ''}) {
        if (!account || !model) return false;
        const verdict = classifyModelPermission(error);
        if (!verdict.kind) return false;
        return this.recordVerdict({
            account,
            model,
            kind: verdict.kind,
            code: verdict.code,
            reason: verdict.reason,
            email,
            baseUrl
        });
    }

    /**
     * 直接按已判定好的结果记一笔
     *
     * 与 recordBlocked 的分工：探测流程（probeOneModel）已经把错误归类过了，
     * 这里直接收结论，不再靠 message 重新猜——那会丢掉 11102 的「权限 vs 模型缺失」区别。
     *
     * @param {Object} params
     * @param {string} params.account
     * @param {string} params.model
     * @param {'forbidden'|'quota'|'missing'} params.kind
     * @param {number|string|null} [params.code]
     * @param {string} [params.reason]
     * @param {string} [params.email]
     * @param {string} [params.baseUrl]
     * @returns {boolean}
     */
    recordVerdict({account, model, kind, code = null, reason = '', email = '', baseUrl = ''}) {
        if (!account || !model || !kind) return false;

        // 先重读磁盘再改：多 worker / 外部写入时，内存快照可能已过期，
        // 直接写回去会把别人刚记的其它模型覆盖掉。
        this.reload();
        const now = Date.now();
        const ttl =
            kind === 'quota' ? QUOTA_TTL_MS : kind === 'missing' ? MISSING_TTL_MS : FORBIDDEN_TTL_MS;

        if (!this.accounts.has(account)) this.accounts.set(account, new Map());
        this.accounts.get(account).set(model, {
            kind,
            code,
            reason,
            at: now,
            expiresAt: now + ttl,
            email,
            baseUrl
        });
        this.save();
        logger.info(`[CodeBuddy] 记录模型状态: ${account} / ${model}（${reason}，${kind}）`);
        return true;
    }

    /**
     * 记一笔「该模型对该账号可用」，清掉之前的不可用记录
     * @param {string} account
     * @param {string} model
     */
    /**
     * 记一笔「该模型对该账号可用」，清掉之前的不可用记录
     *
     * 每次都从磁盘重读再改：权限缓存可能被别的 worker（或用户手动测试）写过，
     * 只信内存里的快照会漏删，导致「明明已经能用了，列表里还标着不可用」。
     * @param {string} account
     * @param {string} model
     */
    recordAvailable(account, model) {
        if (!account || !model) return;
        this.reload();
        const map = this.accounts.get(account);
        if (!map || !map.has(model)) return;
        map.delete(model);
        this.save();
    }

    /**
     * 强制从磁盘重读（丢弃内存快照）
     */
    reload() {
        this._loaded = false;
        this.accounts.clear();
        return this.load();
    }

    /**
     * 该模型对该账号是否已知不可用（自动跳过过期记录）
     * @param {string} account
     * @param {string} model
     * @returns {{blocked: boolean, reason?: string, kind?: string}}
     */
    isBlocked(account, model) {
        this.load();
        const rec = this.accounts.get(account)?.get(model);
        if (!rec) return {blocked: false};
        if (rec.expiresAt && Date.now() >= rec.expiresAt) {
            // 过期即视为恢复：临时的额度限制不该永久生效
            this.accounts.get(account).delete(model);
            this.save();
            return {blocked: false};
        }
        return {blocked: true, reason: rec.reason, kind: rec.kind};
    }

    /**
     * 一个账号下所有已知不可用的模型
     * @param {string} account
     * @returns {Map<string, Object>}
     */
    blockedFor(account) {
        this.load();
        const map = this.accounts.get(account);
        if (!map) return new Map();
        const now = Date.now();
        const out = new Map();
        let pruned = false;
        for (const [model, rec] of map) {
            if (rec.expiresAt && now >= rec.expiresAt) {
                map.delete(model);
                pruned = true;
                continue;
            }
            out.set(model, rec);
        }
        if (pruned) this.save();
        return out;
    }

    /**
     * 清掉某账号的全部记录（重新认证后调用：账号类型可能变了）
     * @param {string} account
     */
    clearAccount(account) {
        this.load();
        if (this.accounts.delete(account)) this.save();
    }

    /**
     * 清空全部
     */
    clearAll() {
        this.load();
        this.accounts.clear();
        this.save();
    }

    /**
     * 落盘（原子写：先写 tmp 再 rename，避免读侧拿到半截 JSON）
     */
    save() {
        const payload = {version: 1, accounts: {}};
        for (const [account, models] of this.accounts) {
            if (models.size === 0) continue;
            payload.accounts[account] = Object.fromEntries(models);
        }

        try {
            if (!existsSync(this.dir)) mkdirSync(this.dir, {recursive: true});
            const tmp = `${this.file}.tmp.${process.pid}`;
            writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            renameSync(tmp, this.file);
        } catch (err) {
            logger.error(`[CodeBuddy] 模型权限缓存保存失败: ${err.message}`);
            try {
                const tmp = `${this.file}.tmp.${process.pid}`;
                if (existsSync(tmp)) unlinkSync(tmp);
            } catch {
                /* ignore */
            }
        }
    }
}

/** 单例：挂在 credential store 的目录下，和凭证放一起 */
export const modelPermissionStore = new ModelPermissionStore();
