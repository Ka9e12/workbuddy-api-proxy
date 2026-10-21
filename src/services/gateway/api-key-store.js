/**
 * 多 API Key 持久化
 *
 * 每个 Key 是一个独立实体：自己的明文、自己的 CodeBuddy 账号白名单。
 * 与旧版 `gateway_token.json`（单令牌、字段平铺）分开存放，
 * 旧文件迁移后冻结只读，作为回滚锚点。
 *
 * 三态作用域是这套模型的核心：
 * - `null`  → 不限账号（含以后新增的）
 * - `[...]` → 白名单（文件名 basename）
 * - `[]`    → 显式全禁（后端防御；面板不允许保存这种状态）
 * `null` 与 `[]` 绝不能互相归一化，否则要么权限放大、要么升级后全部 503。
 *
 * @module services/gateway/api-key-store
 */

import {createHash, randomBytes, timingSafeEqual} from 'crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'fs';
import {basename, join} from 'path';
import logger from '../../utils/logger.js';

export const GATEWAY_DIR = '.gateway';
export const API_KEYS_FILE = 'api_keys.json';
export const LEGACY_TOKEN_FILE = 'gateway_token.json';

/** 单 Key 明文前缀，与旧版保持一致（面板与文档都按 sk- 判断） */
const TOKEN_PREFIX = 'sk-';

/**
 * 生成明文令牌
 * @returns {string}
 */
export function generateToken() {
    return TOKEN_PREFIX + randomBytes(16).toString('hex');
}

/**
 * 由明文算 hash
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * 从 hash 派生稳定 id：迁移来的那条必须每次得到同一个 id，否则重复启动会造出多条。
 * @param {string} hash
 * @returns {string}
 */
function idFromHash(hash) {
    return 'k_' + String(hash).slice(0, 16);
}

/**
 * 十六进制摘要的常量时间比较。
 * 长度检查放在 Buffer.from 之后：非法 hex 会被静默截断而非抛错。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/** 测试专用导出 */
export {timingSafeEqualHex as _timingSafeEqualHex, idFromHash as _idFromHash};

/**
 * 清洗作用域白名单
 *
 * 只接受文件名（`basename` 之后与原文一致才算合法），路径分隔符与 `..` 一律拒绝：
 * 白名单最终要与 `.codebuddy/credentials/` 下的真实文件名比对，
 * 放进来一个 `../x.json` 既匹配不上，又给了路径穿越的想象空间。
 *
 * @param {null|undefined|string[]} value
 * @returns {null|string[]} null 原样保留（不限），数组去重排序
 */
export function normalizeScope(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    for (const raw of value) {
        const name = String(raw || '').trim();
        if (!name) continue;
        if (name !== basename(name)) continue;
        if (name === '.' || name === '..') continue;
        seen.add(name);
    }
    return Array.from(seen).sort();
}

/**
 * Key 存储
 *
 * 全部写操作走「写前重读 + 原子 rename」：
 * PM2 多 worker 会同时写同一文件，直接用内存快照覆盖会把别人刚建的 Key 抹掉。
 */
export class ApiKeyStore {
    /**
     * @param {string} [dir] 存储目录，默认 `<cwd>/.gateway`
     */
    constructor(dir = join(process.cwd(), GATEWAY_DIR)) {
        this.dir = dir;
        this.file = join(dir, API_KEYS_FILE);
        this.legacyFile = join(dir, LEGACY_TOKEN_FILE);
        /** @type {Array<Object>} */
        this.keys = [];
        /** @type {Map<string, Object>} */
        this.byHash = new Map();
        this._initialized = false;
    }

    /**
     * 加载或首次创建
     *
     * 优先级：新文件有内容 → 直接读（永不回读旧文件）；
     *        旧文件有 token_hash → 迁移成一条不限作用域的 Key；
     *        两者皆无 → 生成新 Key。
     * @returns {ApiKeyStore}
     */
    init() {
        if (this._initialized) return this;
        this._ensureDir();

        const loaded = this._readFile();
        if (loaded && loaded.length > 0) {
            this._setKeys(loaded);
            this._initialized = true;
            logger.info(`Gateway API keys loaded from file (${loaded.length})`);
            return this;
        }

        const legacy = this._readLegacy();
        if (legacy) {
            // 迁移：id 由 hash 派生，重复迁移得到同一个 id，不会造出第二条
            const key = {
                id: idFromHash(legacy.token_hash),
                label: '默认',
                token_hash: legacy.token_hash,
                token_prefix: legacy.token_prefix || 'sk-****',
                token_plain: legacy.token_plain || '',
                created_at: legacy.created_at || new Date().toISOString(),
                allowed_credential_files: null
            };
            this._setKeys([key]);
            this._writeFile([key]);
            this._initialized = true;
            logger.info('Gateway token migrated to multi-key store (scope: all credentials)');
            return this;
        }

        const token = generateToken();
        const key = this._newKeyRecord(token, '默认');
        this._setKeys([key]);
        this._writeFile([key]);
        this._initialized = true;
        logger.info('Gateway API key auto-generated');
        if (token) {
            logger.info('  Please save this key, it is also shown in the admin panel.');
        }
        return this;
    }

    /**
     * 幂等重建索引（集群同步用）
     */
    reload() {
        const loaded = this._readFile();
        if (loaded && loaded.length > 0) {
            this._setKeys(loaded);
            logger.info(`Gateway API keys reloaded (${loaded.length})`);
        }
    }

    /**
     * @returns {Array<Object>} 浅拷贝，避免调用方改到内部数组
     */
    list() {
        return this.keys.map((k) => ({...k}));
    }

    /**
     * @param {string} id
     * @returns {Object|null}
     */
    getById(id) {
        const key = this.keys.find((k) => k.id === id);
        return key ? {...key} : null;
    }

    /**
     * 按明文令牌解析 Key
     *
     * 只做一次 sha256 后查表，再对命中项做一次常量时间复核。
     * 不遍历全部 hash：token 是 128 bit 随机串，sha256 有雪崩效应，
     * 按 hash 查表不泄露「猜对了几个字节」；全遍历反而给未鉴权请求
     * 一个 O(N) 的放大点，而且任何一处提前返回都会引入「命中第几个」的时序差异。
     * 复核不是为了防猜，而是让实现不依赖「Map 的键比较是常量时间」这个假设。
     *
     * @param {string} token
     * @returns {Object|null}
     */
    resolve(token) {
        if (typeof token !== 'string' || !token) return null;
        const hash = hashToken(token);
        const hit = this.byHash.get(hash);
        if (!hit) return null;
        if (!timingSafeEqualHex(hash, hit.token_hash)) return null;
        return {...hit, allowedCredentialFiles: hit.allowed_credential_files ?? null};
    }

    /**
     * 新建 Key
     * @param {Object} [opts]
     * @param {string} [opts.label]
     * @param {null|string[]} [opts.allowedCredentialFiles] 省略视为不限
     * @returns {Object} 含明文
     */
    create({label = '', allowedCredentialFiles = null} = {}) {
        const token = generateToken();
        const record = this._newKeyRecord(token, label || `Key ${this.keys.length + 1}`);
        record.allowed_credential_files = normalizeScope(allowedCredentialFiles);

        const next = [...this.keys, record];
        this._commit(next);
        return this._toPublic(record);
    }

    /**
     * 更新 label / 作用域
     * @param {string} id
     * @param {Object} patch
     * @param {string} [patch.label]
     * @param {null|string[]} [patch.allowedCredentialFiles] 只在 key 存在时才生效；null 是合法值
     * @returns {Object|null}
     */
    update(id, patch = {}) {
        const idx = this.keys.findIndex((k) => k.id === id);
        if (idx < 0) return null;

        const record = {...this.keys[idx]};
        if (typeof patch.label === 'string' && patch.label.trim()) {
            record.label = patch.label.trim().slice(0, 64);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'allowedCredentialFiles')) {
            record.allowed_credential_files = normalizeScope(patch.allowedCredentialFiles);
        }

        const next = this.keys.map((k, i) => (i === idx ? record : k));
        this._commit(next);
        return this._toPublic(record);
    }

    /**
     * 删除 Key（拒绝删最后一条：删空就再也进不来了）
     * @param {string} id
     * @returns {{ok: boolean, error?: string}}
     */
    remove(id) {
        if (this.keys.length <= 1) {
            return {ok: false, error: '至少保留一个 API Key'};
        }
        const next = this.keys.filter((k) => k.id !== id);
        if (next.length === this.keys.length) {
            return {ok: false, error: 'Key 不存在'};
        }
        this._commit(next);
        return {ok: true};
    }

    /**
     * 重置指定 Key 的明文（其余 Key 不受影响）
     * @param {string} id
     * @returns {Object|null} 含新明文
     */
    regenerate(id) {
        const idx = this.keys.findIndex((k) => k.id === id);
        if (idx < 0) return null;

        const token = generateToken();
        const record = {
            ...this.keys[idx],
            token_hash: hashToken(token),
            token_prefix: maskToken(token),
            token_plain: token
        };
        const next = this.keys.map((k, i) => (i === idx ? record : k));
        this._commit(next);
        return this._toPublic(record);
    }

    /**
     * 重置第一条（旧 API `regenerateGatewayToken` 的兼容落点）
     * @returns {{id: string, token: string}|null}
     */
    regenerateFirst() {
        const first = this.keys[0];
        if (!first) return null;
        const updated = this.regenerate(first.id);
        return updated ? {id: updated.id, token: updated.plain} : null;
    }

    /** ========== 内部 ========== */

    _ensureDir() {
        if (!existsSync(this.dir)) mkdirSync(this.dir, {recursive: true});
    }

    /**
     * @param {string} token
     * @param {string} label
     * @returns {Object}
     */
    _newKeyRecord(token, label) {
        return {
            id: 'k_' + randomBytes(8).toString('hex'),
            label,
            token_hash: hashToken(token),
            token_prefix: maskToken(token),
            token_plain: token,
            created_at: new Date().toISOString(),
            allowed_credential_files: null
        };
    }

    /**
     * 对外结构：snake_case（磁盘）→ camelCase（API）
     * @param {Object} record
     * @returns {Object}
     */
    _toPublic(record) {
        return {
            id: record.id,
            label: record.label,
            prefix: record.token_prefix,
            plain: record.token_plain,
            createdAt: record.created_at,
            allowedCredentialFiles: record.allowed_credential_files ?? null
        };
    }

    /**
     * 设置内存索引
     * @param {Array<Object>} keys
     */
    _setKeys(keys) {
        this.keys = keys;
        this.byHash = new Map();
        for (const key of keys) {
            if (key?.token_hash) this.byHash.set(key.token_hash, key);
        }
    }

    /**
     * 落盘 + 更新内存
     * @param {Array<Object>} next
     */
    _commit(next) {
        this._writeFile(next);
        this._setKeys(next);
    }

    /**
     * 读新文件；不存在或损坏返回 null
     * @returns {Array<Object>|null}
     */
    _readFile() {
        if (!existsSync(this.file)) return null;
        try {
            const raw = readFileSync(this.file, 'utf8');
            const data = JSON.parse(raw);
            const keys = Array.isArray(data?.keys) ? data.keys : [];
            return keys
                .filter((k) => k && typeof k.token_hash === 'string' && k.token_hash.length > 0)
                .map((k) => ({
                    id: k.id || idFromHash(k.token_hash),
                    label: k.label || '未命名',
                    token_hash: k.token_hash,
                    token_prefix: k.token_prefix || 'sk-****',
                    token_plain: k.token_plain || '',
                    created_at: k.created_at || new Date().toISOString(),
                    allowed_credential_files: normalizeScope(k.allowed_credential_files)
                }));
        } catch (err) {
            logger.error('Failed to load API keys file:', err.message);
            return null;
        }
    }

    /**
     * 读旧单令牌文件
     * @returns {Object|null}
     */
    _readLegacy() {
        if (!existsSync(this.legacyFile)) return null;
        try {
            const data = JSON.parse(readFileSync(this.legacyFile, 'utf8'));
            if (!data?.token_hash) return null;
            return data;
        } catch (err) {
            logger.error('Failed to load legacy gateway token file:', err.message);
            return null;
        }
    }

    /**
     * 原子写：先写 .tmp.<pid> 再 rename，避免读侧读到半截 JSON。
     * @param {Array<Object>} keys
     */
    _writeFile(keys) {
        this._ensureDir();
        const tmp = `${this.file}.tmp.${process.pid}`;
        const payload = {version: 1, keys};
        try {
            writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            renameSync(tmp, this.file);
        } catch (err) {
            logger.error('Failed to save API keys file:', err.message);
            try {
                if (existsSync(tmp)) unlinkSync(tmp);
            } catch {
                /* ignore */
            }
        }
    }
}

/**
 * 掩码：sk- 前缀 + 前 8 位 + **** + 后 4 位
 * 面板靠这个显示，不要在别处另写一份格式
 * @param {string} token
 * @returns {string}
 */
export function maskToken(token) {
    if (typeof token !== 'string' || !token) return 'sk-****';
    const body = token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : token;
    if (body.length <= 12) return TOKEN_PREFIX + '****';
    return TOKEN_PREFIX + body.slice(0, 8) + '****' + body.slice(-4);
}

/** 单例（延迟到 initGatewayAuth 里 init，避免测试 import 时就读盘） */
export const apiKeyStore = new ApiKeyStore();
