/**
 * 租户 Token 管理器
 * 管理指定租户目录下的凭证，支持轮询使用
 * @module services/codebuddy/tenant-token-manager
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync} from 'fs';
import {join, basename} from 'path';
import logger from '../../utils/logger.js';
import {formatDuration} from '../../utils/helpers.js';
import {intEnv} from '../../utils/env.js';
import {DEFAULT_BASE_URL, getCodebuddyBaseUrl, BLOCKED_DOMAINS} from './config.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

class TenantTokenManager {
    /**
     * @param {string} tenantDir - 租户目录绝对路径
     * @param {Object} [options] - 配置选项
     * @param {number} [options.rotationCount=1] - 轮换次数阈值
     */
    constructor(tenantDir, options = {}) {
        this.tenantDir = tenantDir;
        this.credsDir = join(tenantDir, 'credentials');
        this.stateFile = join(tenantDir, 'state.json');

        this.credentials = [];
        this.currentIndex = 0;
        this.usageCount = 0;
        this.manualSelectedIndex = null;
        this.autoRotationEnabled = true;
        this.rotationCount = options.rotationCount ?? 1;
        this.disabledIndexes = [];

        // 冷却追踪：index → {expiry: 时间戳, reason: 冷却来源标签}
        // reason ∈ 'soft'(429) / 'balance'(402) / 'not_found'(404) / 'breaker'(连续5xx熔断)
        this.rateLimitedIndexes = new Map();

        // 模型级冷却：`${index}:${model}` → expiry 时间戳
        // 上游 code 6004 是"该模型用量超限"，不是账号整体被限；切模型立即可用
        this.modelCooldowns = new Map();

        // 连续失败计数：index → {count, firstAt, lastAt}（5xx 熔断用；成功或冷却过期清零）
        // 带时间戳是为了加"时间窗口"：窗口外的散点失败不该被凑成"连续 N 次"（否则几天前
        // 一次 502 会一直挂账、把可用账号误熔断，且阶梯只升不降）。
        this.failureStreaks = new Map();
        // 软冷却连续次数：index → {count, firstAt, lastAt}（429 指数退避用；与熔断计数独立）
        this.softStreaks = new Map();
        // 3) 兜底探测标记：本次选号是否走了全池冷却的兜底路径（用于不推进软冷却计数）
        this.lastPickWasFallback = false;

        // 凭证数据对象 → 索引（供路由层按请求精确定位凭证，替代全局单值 lastReturnedIndex）
        this.dataToIndex = new WeakMap();

        // 会话粘性：conversationKey → {index, expiresAt}，滚动续期 + 惰性清理
        this.sessionAffinity = new Map();
        // 选择策略：'rotation'（默认，保留 rotationCount 语义）| 'weighted'（闲置加权随机）
        this.selectionStrategy = options.selectionStrategy || 'rotation';

        // 手动优先级顺序：凭证稳定 key 的有序数组（面板拖动排序产生）
        // 空数组 = 用户没设置过，保持原有轮转/加权行为。
        // 非空 = 严格优先级：从上到下取第一个可用号，不轮转。
        this.priorityOrder = [];
        // 加权选择参数
        this.idleWeightPerHour = options.idleWeightPerHour ?? 0.5;
        this.idleWeightMax = options.idleWeightMax ?? 5.0;
        this.minPickGap = options.minPickGap ?? 100;
        this.topN = options.topN ?? 5;
        // 最近使用时间/时间戳（闲置权重与防惊群用）
        this.lastUsedAt = new Map();
        this.lastPickedAt = new Map();

        // 连续失败判定窗口：窗口外的失败不计入"连续"（options 优先，其次环境变量，最后静态默认）
        this.breakerWindowMs =
            options.breakerWindowMs ?? intEnv('CODEBUDDY_BREAKER_WINDOW_MS', {default: TenantTokenManager.BREAKER_WINDOW, min: 0});
        this.softWindowMs =
            options.softWindowMs ?? intEnv('CODEBUDDY_SOFT_WINDOW_MS', {default: TenantTokenManager.SOFT_WINDOW, min: 0});

        // 上次返回的凭证索引（保留以兼容既有调用方）
        this.lastReturnedIndex = null;

        this.ensureDirExists();
        this.loadAllTokens();
        this.loadState();
        this.disableBlockedDomainCredentials();
    }

    /** 429 普通软冷却基数（10 分钟，连续触发指数退避） */
    static SOFT_RATE_BASE = 10 * 60 * 1000;
    /** 429 软冷却指数退避封顶（2 小时） */
    static SOFT_RATE_MAX = 2 * 60 * 60 * 1000;
    /** 404 固定短冷却（60 秒） */
    static NOT_FOUND_COOLDOWN = 60 * 1000;
    /** 连续 5xx 触发熔断的阈值 */
    static BREAKER_THRESHOLD = 3;
    /** 熔断"连续"判定窗口：窗口内的失败才累计（10 分钟） */
    static BREAKER_WINDOW = 10 * 60 * 1000;
    /** 429 软冷却"连续"判定窗口（30 分钟；429 是更高频的错误，窗口略宽） */
    static SOFT_WINDOW = 30 * 60 * 1000;
    /** 熔断指数退避基数（30 分钟） */
    static BREAKER_BASE = 30 * 60 * 1000;
    /** 熔断指数退避封顶（6 小时） */
    static BREAKER_MAX = 6 * 60 * 60 * 1000;
    /** 模型级冷却默认时长（5 分钟） */
    static MODEL_COOLDOWN = 5 * 60 * 1000;
    /** 会话粘性绑定默认 TTL（30 分钟） */
    static AFFINITY_TTL = 30 * 60 * 1000;
    /** 兼容旧常量：默认冷却时长（等价于软冷却基数） */
    static RATE_LIMIT_COOLDOWN = 10 * 60 * 1000;

    /**
     * 确保凭证目录存在
     */
    ensureDirExists() {
        if (!existsSync(this.credsDir)) {
            try {
                mkdirSync(this.credsDir, {recursive: true});
                logger.debug(`Created tenant credentials directory: ${this.credsDir}`);
            } catch (error) {
                logger.error(`Failed to create credentials directory: ${error.message}`);
            }
        }
    }

    /**
     * 加载所有 token 文件
     */
    loadAllTokens() {
        this.credentials = [];
        this.currentIndex = 0;

        logger.debug(`Loading tenant credentials from: ${this.credsDir}`);

        if (!existsSync(this.credsDir)) {
            logger.warn(`Credentials directory does not exist: ${this.credsDir}`);
            return;
        }

        try {
            const files = readdirSync(this.credsDir);
            const tokenFiles = files.filter((f) => f.endsWith('.json') && f !== 'state.json');

            for (const file of tokenFiles) {
                try {
                    const filePath = join(this.credsDir, file);
                    const content = readFileSync(filePath, 'utf8');
                    const data = JSON.parse(content);

                    if (data.bearer_token) {
                        this.credentials.push({filePath, data});
                        logger.debug(`Loaded tenant credential: ${file}`);
                    } else {
                        logger.warn(`Skipping invalid credential file (missing bearer_token): ${file}`);
                    }
                } catch (error) {
                    logger.error(`Failed to load credential file ${file}: ${error.message}`);
                }
            }

            logger.debug(`Loaded ${this.credentials.length} tenant credentials`);
        } catch (error) {
            logger.error(`Failed to read credentials directory: ${error.message}`);
        }

        // 重建 凭证数据对象 → index 映射（供路由层精确定位）
        this.dataToIndex = new WeakMap();
        for (let i = 0; i < this.credentials.length; i++) {
            this.dataToIndex.set(this.credentials[i].data, i);
        }

        // 清理越界的状态（凭证增删导致下标变化后，避免残留"幽灵冷却"）
        for (const key of this.rateLimitedIndexes.keys()) {
            if (key >= this.credentials.length) {
                this.rateLimitedIndexes.delete(key);
            }
        }
        for (const key of this.modelCooldowns.keys()) {
            const idx = Number(String(key).split(':')[0]);
            if (!Number.isInteger(idx) || idx >= this.credentials.length) {
                this.modelCooldowns.delete(key);
            }
        }
        for (const key of this.failureStreaks.keys()) {
            if (key >= this.credentials.length) this.failureStreaks.delete(key);
        }
        for (const key of this.softStreaks.keys()) {
            if (key >= this.credentials.length) this.softStreaks.delete(key);
        }

        this._prunePriorityOrder();
    }

    /**
     * 凭证的稳定标识：文件名。
     *
     * 不能用下标——增删任意一个凭证都会让后面所有下标平移，用户排好的优先级会整片错位。
     * 同一账号重新认证时 addCredentialWithData 覆写的是同一个文件（文件名不变），
     * 所以文件名比 user_id 更适合当键（无 user_id 的凭证也有文件名）。 */
    _credentialKey(index) {
        const entry = this.credentials[index];
        return entry ? basename(entry.filePath) : null;
    }

    /**
     * 把 priorityOrder 收敛到当前真实存在的凭证，并去重。
     *
     * 顺序本身要保留（它就是用户意图），只丢掉已经不存在的条目；
     * 没进过 priorityOrder 的新凭证按加载顺序追加到末尾，
     * 这样新加的号不会因为"没排过队"而被永久忽略。
     */
    _prunePriorityOrder() {
        // 空数组 = 用户从未设置过优先级，保持原轮转语义；不能自动填满，
        // 否则"没设置"会被误判成"严格按文件名优先级"。
        if (this.priorityOrder.length === 0) return;

        const existing = new Set(
            this.credentials.map((c) => basename(c.filePath))
        );
        const seen = new Set();
        const kept = [];
        for (const key of this.priorityOrder) {
            if (!existing.has(key) || seen.has(key)) continue;
            seen.add(key);
            kept.push(key);
        }
        for (const key of existing) {
            if (!seen.has(key)) kept.push(key);
        }
        // 全部凭证都排过队时，数组内容与凭证集合等价 —— 这时保留顺序不做任何事，
        // 让 getNextCredential 走原路径（不是"严格优先级"）。
        this.priorityOrder = kept;
    }

    /**
     * 设置手动优先级顺序（面板拖动排序）
     * @param {string[]} filenames - 按优先级从高到低排列的凭证文件名
     * @returns {boolean} 是否成功
     */
    setPriorityOrder(filenames) {
        if (!Array.isArray(filenames)) return false;
        const existing = new Set(this.credentials.map((c) => basename(c.filePath)));
        // 只接受已知文件名的子集，顺序照传入的走；其余保持丢弃
        const accepted = [];
        const seen = new Set();
        for (const raw of filenames) {
            const key = String(raw || '');
            if (!existing.has(key) || seen.has(key)) continue;
            seen.add(key);
            accepted.push(key);
        }
        if (accepted.length === 0) return false;

        // 没在列表里出现的凭证追加到末尾，避免"漏掉一个就再也用不上"
        for (const key of existing) {
            if (!seen.has(key)) accepted.push(key);
        }

        this.priorityOrder = accepted;
        // 排了序就等于重新表达了调度意图，之前点过的「设为活跃」不再适用。
        // 两者都表达"我想用哪个号"，但优先级更完整（是整池的顺序），保留旧的手动
        // 指定会让队首形同虚设：用户把 A 拖到第一，实际却还在用之前点过的 C。
        if (this.manualSelectedIndex !== null) {
            logger.debug(
                `Priority order set, clearing manual selection (was #${this.manualSelectedIndex})`
            );
            this.manualSelectedIndex = null;
        }
        // 顺序变了意味着用户重新表达了意图，旧的绑定关系不再有意义
        this.clearAffinity();
        this.saveState();
        broadcast('codebuddy-state-changed').catch(() => {});
        logger.debug(`Priority order set: ${accepted.join(' > ')}`);
        return true;
    }

    /**
     * 清空手动优先级，回到轮转
     */
    clearPriorityOrder() {
        this.priorityOrder = [];
        this.saveState();
        broadcast('codebuddy-state-changed').catch(() => {});
        logger.debug('Cleared priority order, resumed rotation');
    }

    /**
     * 加载管理器状态
     */
    loadState() {
        try {
            if (existsSync(this.stateFile)) {
                const content = readFileSync(this.stateFile, 'utf8');
                const state = JSON.parse(content);

                const savedManualIndex = state.manualSelectedIndex;
                if (
                    savedManualIndex !== null &&
                    savedManualIndex !== undefined &&
                    savedManualIndex >= 0 &&
                    savedManualIndex < this.credentials.length
                ) {
                    this.manualSelectedIndex = savedManualIndex;
                    this.currentIndex = savedManualIndex;
                    logger.debug(`Restored manual selection: index ${savedManualIndex}`);
                }

                if (state.autoRotationEnabled !== undefined) {
                    this.autoRotationEnabled = state.autoRotationEnabled;
                }

                if (state.rotationCount !== undefined) {
                    this.rotationCount = state.rotationCount;
                }

                if (Array.isArray(state.disabledIndexes)) {
                    this.disabledIndexes = state.disabledIndexes.filter(
                        i => i >= 0 && i < this.credentials.length
                    );
                }

                if (Array.isArray(state.priorityOrder)) {
                    this.priorityOrder = state.priorityOrder.map(String);
                    this._prunePriorityOrder();
                }

                if (this.manualSelectedIndex === null && state.currentIndex !== undefined) {
                    if (state.currentIndex >= 0 && state.currentIndex < this.credentials.length) {
                        this.currentIndex = state.currentIndex;
                    }
                }
            }
        } catch (error) {
            logger.warn(`Failed to load tenant manager state: ${error.message}`);
        }
    }

    /**
     * 保存管理器状态
     */
    saveState() {
        try {
            this.ensureDirExists();

            const state = {
                autoRotationEnabled: this.autoRotationEnabled,
                currentIndex: this.currentIndex,
                manualSelectedIndex: this.manualSelectedIndex,
                rotationCount: this.rotationCount,
                disabledIndexes: this.disabledIndexes,
                priorityOrder: this.priorityOrder,
                savedAt: Date.now()
            };

            writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
        } catch (error) {
            logger.error(`Failed to save tenant manager state: ${error.message}`);
        }
    }

    /**
     * 自动禁用包含已废弃域名的凭证，并切换到下一个可用凭证
     */
    disableBlockedDomainCredentials() {
        if (BLOCKED_DOMAINS.length === 0 || this.credentials.length === 0) return;

        let changed = false;
        for (let i = 0; i < this.credentials.length; i++) {
            const baseUrl = getCodebuddyBaseUrl(this.credentials[i].data.base_url);
            try {
                const host = new URL(baseUrl).host;
                if (BLOCKED_DOMAINS.includes(host) && !this.disabledIndexes.includes(i)) {
                    this.disabledIndexes.push(i);
                    logger.debug(`Auto-disabled credential #${i} (blocked domain: ${host}): ${basename(this.credentials[i].filePath)}`);
                    changed = true;
                }
            } catch {
                // 忽略无效 URL
            }
        }

        if (changed) {
            // 当前凭证被禁用时，切换到下一个可用凭证
            if (this.disabledIndexes.includes(this.currentIndex)) {
                const nextAvailable = this.credentials.findIndex(
                    (_, i) => !this.disabledIndexes.includes(i) && !this.isTokenExpired(this.credentials[i].data)
                );
                this.currentIndex = nextAvailable >= 0 ? nextAvailable : 0;
            }
            this.saveState();
        }
    }

    /**
     * 检查 token 是否过期
     * @param {Object} credentialData
     * @returns {boolean}
     */
    isTokenExpired(credentialData) {
        const createdAt = credentialData.created_at;
        const expiresIn = credentialData.expires_in;

        if (!createdAt || !expiresIn) {
            return false;
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const expiryTime = createdAt + expiresIn;
        const bufferTime = 300;

        const isExpired = currentTime >= expiryTime - bufferTime;

        if (isExpired) {
            const userId = credentialData.user_id || 'unknown';
            logger.warn(`Token for user ${userId} is expired or will expire soon`);
        }

        return isExpired;
    }

    /**
     * 获取下一个可用的凭证
     * 优先级：手动选择 > 会话粘性 > 轮换/加权选择
     * 被禁用的凭证跳过；处于冷却的凭证临时跳过
     * @param {Object} [opts]
     * @param {string} [opts.sessionKey] - 会话键（用于粘性绑定）
     * @param {string} [opts.model] - 当前请求模型（用于模型级冷却判定）
     * @returns {Object|null}
     */
    getNextCredential(opts = {}) {
        const {sessionKey, model} = opts;
        if (this.credentials.length === 0) {
            return null;
        }

        // 惰性清理过期标记
        this._cleanupRateLimited();
        this._cleanupAffinity();

        const validCredentials = [];
        for (let i = 0; i < this.credentials.length; i++) {
            if (this.disabledIndexes.includes(i)) {
                continue;
            }
            if (this.isRateLimited(i)) {
                continue;
            }
            // 模型级冷却：仅当请求指定模型且该模型对被冷却时跳过
            if (model && this.isModelCooled(i, model)) {
                continue;
            }
            if (!this.isTokenExpired(this.credentials[i].data)) {
                validCredentials.push({index: i, credential: this.credentials[i]});
            }
        }

        // 0) 每次选号先重置兜底标记（下面各正常分支覆盖为 false，兜底分支置 true）
        this.lastPickWasFallback = false;

        if (validCredentials.length === 0) {
            // 所有凭证都在冷却：兜底选"最早到期"的那个临时代班（不打穿长冷却）
            // 纪律：不得清空冷却标记、不得推进任何计数（否则重试本身把账号越推越冷）
            const fallback = this._selectFallback(model);
            if (fallback) return fallback;
            logger.error('No valid (non-expired) credentials available');
            this.lastReturnedIndex = null;
            return null;
        }

        const currentValidIndices = validCredentials.map((vc) => vc.index);
        if (!currentValidIndices.includes(this.currentIndex)) {
            this.currentIndex = currentValidIndices[0];
            this.usageCount = 0;
        }

        // 1) 手动选择优先
        if (
            this.manualSelectedIndex !== null &&
            this.manualSelectedIndex >= 0 &&
            this.manualSelectedIndex < this.credentials.length
        ) {
            if (this.disabledIndexes.includes(this.manualSelectedIndex)) {
                logger.warn('Manually selected credential is disabled, falling back to automatic rotation');
                this.manualSelectedIndex = null;
            } else if (this.isRateLimited(this.manualSelectedIndex) || (model && this.isModelCooled(this.manualSelectedIndex, model))) {
                // 不清除 manualSelectedIndex，冷却过期后会自动恢复
                logger.warn('Manually selected credential is cooling down, temporarily falling back');
            } else {
                const manualCred = this.credentials[this.manualSelectedIndex];
                if (!this.isTokenExpired(manualCred.data)) {
                    this._touchPick(this.manualSelectedIndex);
                    return manualCred.data;
                }
                logger.warn('Manually selected credential is expired, falling back to automatic rotation');
                this.manualSelectedIndex = null;
            }
        }

        // 2) 手动优先级顺序：面板拖动排序后，从上往下取第一个可用号。
        //    压在会话粘性之前 —— 用户显式排了序，就不该被 30 分钟前的绑定覆盖。
        //    黏性绑定仍在下面照常写入，所以同一会话后续仍落在同一个号上。
        if (this.priorityOrder.length > 0) {
            const pickedIndex = this._pickByPriority(validCredentials);
            if (pickedIndex !== null) {
                if (sessionKey) {
                    this.sessionAffinity.set(sessionKey, {
                        index: pickedIndex,
                        expiresAt: Date.now() + TenantTokenManager.AFFINITY_TTL
                    });
                }
                this._touchPick(pickedIndex);
                return this.credentials[pickedIndex].data;
            }
        }

        // 3) 会话粘性：命中且该凭证仍可用则复用（不递增 usageCount）
        if (sessionKey) {
            const bound = this.sessionAffinity.get(sessionKey);
            if (bound) {
                if (currentValidIndices.includes(bound.index)) {
                    bound.expiresAt = Date.now() + TenantTokenManager.AFFINITY_TTL;
                    this._touchPick(bound.index);
                    logger.debug(`Affinity hit: ${sessionKey} → credential #${bound.index}`);
                    return this.credentials[bound.index].data;
                }
                // 绑定的凭证已不可用 → 解绑重选
                this.sessionAffinity.delete(sessionKey);
                logger.debug(`Affinity unbind (credential unavailable): ${sessionKey}`);
            }
        }

        // 4) 选择
        let pickedIndex;
        if (this.selectionStrategy === 'weighted') {
            pickedIndex = this._pickWeighted(validCredentials);
        } else {
            pickedIndex = this._pickRotate(validCredentials, currentValidIndices);
        }

        // 绑定会话（若本次是带 sessionKey 的聊天请求）
        if (sessionKey) {
            this.sessionAffinity.set(sessionKey, {
                index: pickedIndex,
                expiresAt: Date.now() + TenantTokenManager.AFFINITY_TTL
            });
        }

        this._touchPick(pickedIndex);
        return this.credentials[pickedIndex].data;
    }

    /**
     * 记录一次选择：刷新防惊群/闲置计时
     */
    _touchPick(index) {
        const now = Date.now();
        this.lastPickedAt.set(index, now);
        this.lastUsedAt.set(index, now);
        this.lastReturnedIndex = index;
    }

    /**
     * 按手动优先级顺序选择：返回顺序里第一个可用的下标
     * @param {Array<{index:number}>} validCredentials - 已过滤掉冷却/禁用/过期的候选
     * @returns {number|null} 无候选时返回 null（调用方落到后续策略）
     */
    _pickByPriority(validCredentials) {
        const valid = new Set(validCredentials.map((vc) => vc.index));
        for (const key of this.priorityOrder) {
            const idx = this.credentials.findIndex((c) => basename(c.filePath) === key);
            if (idx >= 0 && valid.has(idx)) return idx;
        }
        return null;
    }

    /**
     * 兜底选择（全池冷却时）：按最早的冷却到期时间挑一个，且不推进任何计数
     * @param {string} [model]
     * @returns {Object|null}
     */
    _selectFallback(model) {
        let bestIndex = -1;
        let bestExpiry = Infinity;
        for (let i = 0; i < this.credentials.length; i++) {
            if (this.disabledIndexes.includes(i)) continue;
            if (this.isTokenExpired(this.credentials[i].data)) continue;
            if (model && this.isModelCooled(i, model)) continue;
            const rec = this.rateLimitedIndexes.get(i);
            const expiry = rec ? rec.expiry : 0;
            if (expiry < bestExpiry) {
                bestExpiry = expiry;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) {
            logger.error('No credential available even after fallback');
            this.lastReturnedIndex = null;
            return null;
        }
        logger.warn(`Fallback pick: credential #${bestIndex} (earliest cooldown expiry)`);
        this.lastReturnedIndex = bestIndex;
        // 标记本次走了兜底路径：调用方据此不推进软冷却连续计数
        this.lastPickWasFallback = true;
        return this.credentials[bestIndex].data;
    }

    /**
     * 轮换选择（保留 rotationCount 语义）
     * @param {Array} validCredentials
     * @param {Array} currentValidIndices
     * @returns {number} 选中的索引
     */
    _pickRotate(validCredentials, currentValidIndices) {
        const shouldRotate = this.autoRotationEnabled && this.rotationCount > 0;

        if (!shouldRotate) {
            return this.currentIndex;
        }

        if (this.usageCount >= this.rotationCount) {
            const currentValidPosition = currentValidIndices.indexOf(this.currentIndex);
            const nextValidPosition = (currentValidPosition + 1) % validCredentials.length;
            this.currentIndex = currentValidIndices[nextValidPosition];
            this.usageCount = 0;
        }
        this.usageCount++;
        return this.currentIndex;
    }

    /**
     * 闲置加权选择：weight = 闲置小时 × perHour（封顶），Top-N 短名单内加权随机
     * 防惊群：跳过刚被选中的（minPickGap 内）；等权重时洗牌避免固定顺序偏置
     * @param {Array} validCredentials
     * @returns {number} 选中的索引
     */
    _pickWeighted(validCredentials) {
        const now = Date.now();
        const scored = validCredentials.map(({index}) => {
            const last = this.lastUsedAt.get(index);
            const idleHours = last ? (now - last) / 3600000 : Infinity;
            const idleWeight = idleHours === Infinity
                ? this.idleWeightMax
                : Math.min(idleHours * this.idleWeightPerHour, this.idleWeightMax);
            return {index, weight: idleWeight};
        });

        // 先按权重降序取 Top-N，再在短名单内加权随机
        scored.sort((a, b) => b.weight - a.weight);
        let candidates = scored.slice(0, this.topN);

        // 防惊群：剔除 minPickGap 内刚被选中的
        const fresh = candidates.filter(({index}) => {
            const lastPick = this.lastPickedAt.get(index);
            return !lastPick || now - lastPick >= this.minPickGap;
        });
        if (fresh.length > 0) candidates = fresh;

        if (candidates.length === 1) return candidates[0].index;

        // 等权重洗牌（Fisher-Yates），避免靠前索引垄断
        const total = candidates.reduce((s, c) => s + c.weight, 0);
        if (total <= 0) {
            const j = Math.floor(Math.random() * candidates.length);
            return candidates[j].index;
        }
        let r = Math.random() * total;
        for (const c of candidates) {
            r -= c.weight;
            if (r <= 0) return c.index;
        }
        return candidates[candidates.length - 1].index;
    }

    /**
     * 惰性清理过期的会话粘性绑定
     */
    _cleanupAffinity() {
        if (this.sessionAffinity.size === 0) return;
        const now = Date.now();
        for (const [key, bind] of this.sessionAffinity) {
            if (now >= bind.expiresAt) this.sessionAffinity.delete(key);
        }
    }

    /**
     * 解绑某会话（请求失败时调用）
     * @param {string} sessionKey
     */
    unbindSession(sessionKey) {
        if (sessionKey && this.sessionAffinity.has(sessionKey)) {
            this.sessionAffinity.delete(sessionKey);
            logger.debug(`Affinity unbound on failure: ${sessionKey}`);
        }
    }

    /**
     * 清空全部会话粘性绑定（手动切换凭证时调用）
     */
    clearAffinity() {
        if (this.sessionAffinity.size > 0) {
            this.sessionAffinity.clear();
            logger.debug('All session affinity bindings cleared');
        }
    }

    /**
     * 按凭证数据对象查索引（供路由层精确归因）
     * @param {Object} credentialData
     * @returns {number} 索引，未找到返回 -1
     */
    indexOfCredential(credentialData) {
        if (!credentialData) return -1;
        const idx = this.dataToIndex.get(credentialData);
        return idx === undefined ? -1 : idx;
    }

    /**
     * 只读获取一个当前可用凭证（不推进轮换计数、不绑定会话）
     * 用于模型列表等非聊天查询，避免其副作用干扰轮换节奏
     * @returns {Object|null}
     */
    peekCredential() {
        if (this.credentials.length === 0) return null;
        this._cleanupRateLimited();
        // 优先手动选择
        if (
            this.manualSelectedIndex !== null &&
            this.manualSelectedIndex >= 0 &&
            this.manualSelectedIndex < this.credentials.length &&
            !this.disabledIndexes.includes(this.manualSelectedIndex) &&
            !this.isRateLimited(this.manualSelectedIndex) &&
            !this.isTokenExpired(this.credentials[this.manualSelectedIndex].data)
        ) {
            return this.credentials[this.manualSelectedIndex].data;
        }
        // 其次当前轮换位
        if (
            this.currentIndex >= 0 &&
            this.currentIndex < this.credentials.length &&
            !this.disabledIndexes.includes(this.currentIndex) &&
            !this.isRateLimited(this.currentIndex) &&
            !this.isTokenExpired(this.credentials[this.currentIndex].data)
        ) {
            return this.credentials[this.currentIndex].data;
        }
        // 最后第一个可用者
        for (let i = 0; i < this.credentials.length; i++) {
            if (
                !this.disabledIndexes.includes(i) &&
                !this.isRateLimited(i) &&
                !this.isTokenExpired(this.credentials[i].data)
            ) {
                return this.credentials[i].data;
            }
        }
        return null;
    }

    /**
     * 惰性清理过期的冷却标记
     * 在每次 getNextCredential 时顺便执行，不依赖定时器
     */
    _cleanupRateLimited() {
        const now = Date.now();
        for (const [index, rec] of this.rateLimitedIndexes) {
            if (now >= rec.expiry) {
                this.rateLimitedIndexes.delete(index);
                // 冷却自然过期：连续失败/软冷却计数归零（"兜底探测不推进计数"的反面——正常恢复也清零）
                this.failureStreaks.delete(index);
                this.softStreaks.delete(index);
                logger.debug(`Cooldown expired for credential #${index} (${rec.reason})`);
            }
        }
        // 清理过期的模型级冷却
        for (const [key, expiry] of this.modelCooldowns) {
            if (now >= expiry) this.modelCooldowns.delete(key);
        }
    }

    /**
     * 平移冷却相关索引（凭证数组增删后调用）
     * 移除等于 removedIndex 的键，大于 removedIndex 的键减一，与 disabledIndexes 的平移保持一致
     * @param {number} removedIndex - 被删除的凭证索引
     */
    _shiftRateLimitedIndexes(removedIndex) {
        if (this.rateLimitedIndexes.size > 0) {
            const shifted = new Map();
            for (const [key, rec] of this.rateLimitedIndexes) {
                if (key === removedIndex) continue;
                shifted.set(key > removedIndex ? key - 1 : key, rec);
            }
            this.rateLimitedIndexes = shifted;
        }

        // 模型级冷却：键形如 `${index}:${model}`
        if (this.modelCooldowns.size > 0) {
            const shiftedModel = new Map();
            for (const [key, expiry] of this.modelCooldowns) {
                const sep = String(key).indexOf(':');
                const idx = Number(String(key).slice(0, sep));
                const model = String(key).slice(sep + 1);
                if (idx === removedIndex) continue;
                shiftedModel.set(`${idx > removedIndex ? idx - 1 : idx}:${model}`, expiry);
            }
            this.modelCooldowns = shiftedModel;
        }

        for (const map of [this.failureStreaks, this.softStreaks]) {
            if (map.size === 0) continue;
            const shifted = new Map();
            for (const [key, val] of map) {
                if (key === removedIndex) continue;
                shifted.set(key > removedIndex ? key - 1 : key, val);
            }
            // 泛型平移：只依赖 key，值结构（number → {count, firstAt, lastAt}）变化不影响
            if (map === this.failureStreaks) this.failureStreaks = shifted;
            else this.softStreaks = shifted;
        }
    }

    /**
     * 标记凭证冷却
     * 多机制取更长者、不叠加：同一 index 重复标记时只在更晚到期时覆盖
     * @param {number} index - 凭证索引
     * @param {number} durationMs - 冷却时长（毫秒）
     * @param {string} [reason='soft'] - 冷却来源标签
     */
    markRateLimited(index, durationMs, reason = 'soft') {
        if (!Number.isInteger(index) || index < 0 || index >= this.credentials.length) return;
        const duration = durationMs || TenantTokenManager.SOFT_RATE_BASE;
        const expiry = Date.now() + duration;
        const existing = this.rateLimitedIndexes.get(index);
        if (existing && existing.expiry >= expiry) {
            // 已有更长的冷却，保留（多机制取更长者）
            return;
        }
        this.rateLimitedIndexes.set(index, {expiry, reason});
        const filename = basename(this.credentials[index].filePath);
        logger.warn(
            `Credential #${index} (${filename}) 冷却 ${Math.round(duration / 1000)}s [${reason}]`
        );
    }

    /**
     * 标记模型级冷却（上游 code 6004：该模型用量超限，账号整体仍可用）
     * @param {number} index - 凭证索引
     * @param {string} model - 模型名
     * @param {number} [durationMs] - 冷却时长，默认 5 分钟
     */
    markModelCooldown(index, model, durationMs) {
        if (!model || !Number.isInteger(index) || index < 0 || index >= this.credentials.length) return;
        const duration = durationMs || TenantTokenManager.MODEL_COOLDOWN;
        const key = `${index}:${model}`;
        const expiry = Date.now() + duration;
        const existing = this.modelCooldowns.get(key);
        if (existing && existing >= expiry) return;
        this.modelCooldowns.set(key, expiry);
        const filename = basename(this.credentials[index].filePath);
        logger.warn(`Credential #${index} (${filename}) 模型 ${model} 冷却 ${Math.round(duration / 1000)}s`);
    }

    /**
     * 检查凭证的某模型是否处于冷却期
     * @param {number} index
     * @param {string} [model] - 不传则只检查账号级冷却
     * @returns {boolean}
     */
    isModelCooled(index, model) {
        if (!model) return false;
        const expiry = this.modelCooldowns.get(`${index}:${model}`);
        if (!expiry) return false;
        if (Date.now() >= expiry) {
            this.modelCooldowns.delete(`${index}:${model}`);
            return false;
        }
        return true;
    }

    /**
     * 检查凭证是否处于冷却期
     * @param {number} index - 凭证索引
     * @returns {boolean}
     */
    isRateLimited(index) {
        const rec = this.rateLimitedIndexes.get(index);
        if (!rec) return false;
        if (Date.now() >= rec.expiry) {
            this.rateLimitedIndexes.delete(index);
            this.failureStreaks.delete(index);
            this.softStreaks.delete(index);
            return false;
        }
        return true;
    }

    /**
     * 获取凭证的冷却剩余与来源（供管理面板展示）
     * @param {number} index
     * @returns {{limited: boolean, remainingMs: number, reason: string|null}}
     */
    getRateLimitInfo(index) {
        if (!this.isRateLimited(index)) return {limited: false, remainingMs: 0, reason: null};
        const rec = this.rateLimitedIndexes.get(index);
        return {limited: true, remainingMs: Math.max(0, rec.expiry - Date.now()), reason: rec.reason};
    }

    /**
     * 在时间窗口内累计连续失败次数
     * 窗口外的旧记录从 1 重新计数——避免"几天前一次 + 昨天一次 + 刚才一次"被凑成连续 N 次
     * @param {Map} map - failureStreaks 或 softStreaks
     * @param {number} index
     * @param {number} windowMs - 判定窗口（毫秒）
     * @returns {{count: number, firstAt: number, lastAt: number}} 累计后的记录
     */
    _bumpStreak(map, index, windowMs) {
        const now = Date.now();
        const rec = map.get(index);
        const next = (!rec || now - rec.firstAt > windowMs)
            ? {count: 1, firstAt: now, lastAt: now}
            : {count: rec.count + 1, firstAt: rec.firstAt, lastAt: now};
        map.set(index, next);
        return next;
    }

    /**
     * 记录一次熔断计数（连续 5xx），达阈值则熔断
     * 幂等纪律：正常成功或冷却自然过期时清零；"兜底探测"不得调用本方法
     * @param {number} index
     * @returns {boolean} 是否触发了熔断
     */
    noteFailure(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.credentials.length) return false;
        const rec = this._bumpStreak(this.failureStreaks, index, this.breakerWindowMs);
        if (rec.count >= TenantTokenManager.BREAKER_THRESHOLD) {
            const over = rec.count - TenantTokenManager.BREAKER_THRESHOLD;
            const duration = Math.min(
                TenantTokenManager.BREAKER_BASE * 2 ** over,
                TenantTokenManager.BREAKER_MAX
            );
            this.markRateLimited(index, duration, 'breaker');
            return true;
        }
        return false;
    }

    /**
     * 记录一次软冷却（429），按连续次数指数退避
     * @param {number} index
     * @param {Object} [opts]
     * @param {boolean} [opts.fromFallback=false] - 是否来自全池兜底探测（是则不计入连续次数）
     * @returns {number} 本次冷却时长（毫秒）
     */
    noteSoftRateLimit(index, {fromFallback = false} = {}) {
        if (!Number.isInteger(index) || index < 0 || index >= this.credentials.length) return 0;
        // 兜底探测不推进连续计数（否则重试本身会把账号越推越冷），仅施加基础冷却时长
        const streak = fromFallback
            ? 1
            : this._bumpStreak(this.softStreaks, index, this.softWindowMs).count;
        const duration = Math.min(
            TenantTokenManager.SOFT_RATE_BASE * 2 ** (streak - 1),
            TenantTokenManager.SOFT_RATE_MAX
        );
        this.markRateLimited(index, duration, 'soft');
        return duration;
    }

    /**
     * 记录一次成功：清零连续失败/软冷却计数
     * @param {number} index
     */
    noteSuccess(index) {
        if (!Number.isInteger(index)) return;
        this.failureStreaks.delete(index);
        this.softStreaks.delete(index);
    }

    /**
     * 计算"冷却到次日 04:00"的毫秒数（余额不足 402 用）
     * @returns {number}
     */
    static untilNext4AM() {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 0, 0);
        if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1);
        }
        return next.getTime() - now.getTime();
    }

    /**
     * 重置单项凭证的冷却状态（区别于 setManualCredential 的"清空全部"语义）
     * 仅清除目标 index 的冷却标记；可选同时解除禁用
     * 本方法不触发 broadcast（由调用方按需广播），避免集群广播往返风暴
     * @param {number} index - 凭证索引
     * @param {Object} [options]
     * @param {boolean} [options.clearDisabled=false] - 是否同时解除禁用
     * @returns {{ok: boolean, wasRateLimited: boolean, wasDisabled: boolean, reason?: string}}
     */
    resetRateLimit(index, {clearDisabled = false} = {}) {
        if (!Number.isInteger(index) || index < 0 || index >= this.credentials.length) {
            return {ok: false, wasRateLimited: false, wasDisabled: false, reason: 'invalid-index'};
        }

        const wasRateLimited = this.rateLimitedIndexes.has(index);
        this.rateLimitedIndexes.delete(index);
        this.failureStreaks.delete(index);
        this.softStreaks.delete(index);
        for (const key of [...this.modelCooldowns.keys()]) {
            if (String(key).startsWith(`${index}:`)) this.modelCooldowns.delete(key);
        }

        let wasDisabled = false;
        if (clearDisabled) {
            const pos = this.disabledIndexes.indexOf(index);
            if (pos >= 0) {
                this.disabledIndexes.splice(pos, 1);
                wasDisabled = true;
                this.saveState();
            }
        }

        logger.info(
            `Credential #${index} 状态已重置 (限速=${wasRateLimited}, 禁用=${wasDisabled})`
        );
        return {ok: true, wasRateLimited, wasDisabled};
    }

    /**
     * 获取上次返回的凭证索引
     * @returns {number|null}
     */
    getLastReturnedIndex() {
        return this.lastReturnedIndex;
    }

    /**
     * 标记上次使用的凭证为 429 限速（保留兼容；新代码应优先按请求传 index）
     * @param {number} [durationMs] - 限速持续时间（毫秒）
     * @param {string} [reason='soft'] - 冷却来源标签
     */
    markLastReturnedRateLimited(durationMs, reason = 'soft') {
        if (this.lastReturnedIndex !== null) {
            this.markRateLimited(this.lastReturnedIndex, durationMs, reason);
        }
    }

    /**
     * 添加新凭证（完整数据）
     * @param {Object} credentialData
     * @param {string} [filename]
     * @returns {boolean}
     */
    addCredentialWithData(credentialData, filename = null) {
        if (!credentialData.created_at) {
            credentialData.created_at = Math.floor(Date.now() / 1000);
        }

        // 同一用户只保留最新凭证，更新而非新增
        const userId = credentialData.user_id;
        if (userId) {
            const existing = this.credentials.find(c => c.data.user_id === userId);
            if (existing) {
                try {
                    this.ensureDirExists();
                    writeFileSync(existing.filePath, JSON.stringify(credentialData, null, 4), 'utf8');
                    logger.debug(`Updated existing credential for user: ${userId}`);
                    this.loadAllTokens();
                    this.autoSelectByUserId(userId);
                    broadcast('codebuddy-credentials-changed').catch(() => {});
                    return true;
                } catch (error) {
                    logger.error(`Failed to update credential: ${error.message}`);
                    return false;
                }
            }
        }

        if (!filename) {
            const timestamp = credentialData.created_at;
            const safeUserId = String(userId || 'unknown')
                .replace(/[^a-zA-Z0-9._-]/g, '')
                .slice(0, 20);
            filename = `codebuddy_${safeUserId}_${timestamp}.json`;
        }

        if (!filename.endsWith('.json')) {
            filename += '.json';
        }

        const filePath = join(this.credsDir, filename);

        try {
            this.ensureDirExists();
            writeFileSync(filePath, JSON.stringify(credentialData, null, 4), 'utf8');
            logger.debug(`Added new tenant credential: ${filename}`);
            this.loadAllTokens();
            this.autoSelectByUserId(userId);
            broadcast('codebuddy-credentials-changed').catch(() => {});
            return true;
        } catch (error) {
            logger.error(`Failed to save credential: ${error.message}`);
            return false;
        }
    }

    /**
     * 新凭证入列后把它排到优先级第一位
     *
     * 刻意不走 setManualCredential：那方法会顺带清空全池冷却标记，
     * 而"加了个新号"不等于"其他号的冷却都不算数了"——那会把 402 余额不足
     * 之类的真实状态一起抹掉。
     *
     * 用户已经排过序时不打断他的顺序：新号补到队尾排队。
     * @param {string} userId
     */
    autoSelectByUserId(userId) {
        if (!userId) return;
        if (this.priorityOrder.length > 0) return;
        const idx = this.credentials.findIndex((c) => c.data.user_id === userId);
        if (idx < 0) return;

        // 用"新号在最前，其余保持加载顺序"建立初始优先级
        const key = basename(this.credentials[idx].filePath);
        const others = this.credentials
            .map((c) => basename(c.filePath))
            .filter((f) => f !== key);
        this.priorityOrder = [key, ...others];
        // 手动选择是旧机制，这里清掉避免它盖过优先级
        this.manualSelectedIndex = null;
        this.clearAffinity();
        this.saveState();
        broadcast('codebuddy-state-changed').catch(() => {});
        logger.debug(`New credential promoted to priority head: ${key}`);
    }

    /**
     * 删除凭证
     * @param {number} index
     * @returns {boolean}
     */
    deleteCredential(index) {
        try {
            if (index < 0 || index >= this.credentials.length) {
                logger.error(`Invalid credential index for deletion: ${index}`);
                return false;
            }

            const filePath = this.credentials[index].filePath;
            const filename = basename(filePath);

            if (existsSync(filePath)) {
                unlinkSync(filePath);
                logger.debug(`Deleted credential file: ${filename}`);
            } else {
                logger.warn(`Credential file already missing: ${filename}`);
            }

            if (this.manualSelectedIndex === index) {
                this.manualSelectedIndex = null;
                logger.debug('Cleared manual selection because deleted credential was selected');
            } else if (this.manualSelectedIndex !== null && this.manualSelectedIndex > index) {
                this.manualSelectedIndex--;
            }

            // 更新禁用索引：移除被删除的索引，大于它的索引减一
            this.disabledIndexes = this.disabledIndexes
                .filter(i => i !== index)
                .map(i => i > index ? i - 1 : i);

            // 同步平移限速索引，避免下标错位产生"幽灵冷却"
            this._shiftRateLimitedIndexes(index);

            this.loadAllTokens();
            broadcast('codebuddy-credentials-changed').catch(() => {});
            return true;
        } catch (error) {
            logger.error(`Failed to delete credential at index ${index}: ${error.message}`);
            return false;
        }
    }

    /**
     * 手动选择凭证
     * @param {number} index
     * @returns {boolean}
     */
    setManualCredential(index) {
        if (index >= 0 && index < this.credentials.length) {
            this.manualSelectedIndex = index;
            this.currentIndex = index;
            // 切换活跃凭证时清除所有冷却标记与粘性绑定，立即生效（既有语义）
            this.rateLimitedIndexes.clear();
            this.modelCooldowns.clear();
            this.failureStreaks.clear();
            this.softStreaks.clear();
            this.clearAffinity();
            const filename = basename(this.credentials[index].filePath);
            logger.debug(`Manually selected credential: ${filename} (index: ${index})`);
            this.saveState();
            broadcast('codebuddy-state-changed').catch(() => {});
            return true;
        } else {
            logger.error(`Invalid credential index: ${index}`);
            return false;
        }
    }

    /**
     * 清除手动选择
     */
    clearManualSelection() {
        this.manualSelectedIndex = null;
        logger.debug('Cleared manual credential selection, resumed automatic rotation');
        this.saveState();
    }

    /**
     * 修改轮换次数
     * @param {number} count
     */
    setRotationCount(count) {
        this.rotationCount = Math.max(1, parseInt(count, 10) || 1);
        this.saveState();
        logger.debug(`Rotation count set to: ${this.rotationCount}`);
    }

    /**
     * 设置自动轮换
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setAutoRotation(enabled) {
        this.autoRotationEnabled = !!enabled;
        this.saveState();
        return this.autoRotationEnabled;
    }

    /**
     * 切换自动轮换
     * @returns {boolean}
     */
    toggleAutoRotation() {
        this.autoRotationEnabled = !this.autoRotationEnabled;
        const status = this.autoRotationEnabled ? 'enabled' : 'disabled';
        logger.debug(`Auto rotation toggled: ${status}`);
        this.saveState();
        return this.autoRotationEnabled;
    }

    /**
     * 切换凭证的启用/禁用状态
     * @param {number} index - 凭证索引
     * @returns {{disabled: boolean}} 切换后的禁用状态
     */
    toggleCredentialDisable(index) {
        if (index < 0 || index >= this.credentials.length) {
            logger.error(`Invalid credential index for toggle disable: ${index}`);
            return {disabled: false};
        }

        const pos = this.disabledIndexes.indexOf(index);
        if (pos >= 0) {
            this.disabledIndexes.splice(pos, 1);
            logger.debug(`Credential #${index} enabled: ${basename(this.credentials[index].filePath)}`);
        } else {
            this.disabledIndexes.push(index);
            logger.debug(`Credential #${index} disabled: ${basename(this.credentials[index].filePath)}`);
            // 如果禁用的是当前手动选中的凭证，清除手动选择
            if (this.manualSelectedIndex === index) {
                this.manualSelectedIndex = null;
            }
            // 如果禁用的是当前轮换到的凭证，重置到下一个可用凭证
            if (this.currentIndex === index) {
                const nextAvailable = this.credentials.findIndex(
                    (_, i) => !this.disabledIndexes.includes(i) && !this.isTokenExpired(this.credentials[i].data)
                );
                this.currentIndex = nextAvailable >= 0 ? nextAvailable : 0;
                this.usageCount = 0;
            }
        }

        this.saveState();
        broadcast('codebuddy-state-changed').catch(() => {});
        return {disabled: this.disabledIndexes.includes(index)};
    }

    /**
     * 获取所有凭证信息
     * @returns {Array}
     */
    getCredentialsInfo() {
        const list = this.credentials.map((cred, index) => {
            const data = cred.data;
            const filename = basename(cred.filePath);

            const isExpired = this.isTokenExpired(data);
            let expiresAt = null;
            let timeRemaining = null;

            if (data.created_at && data.expires_in) {
                expiresAt = data.created_at + data.expires_in;
                timeRemaining = expiresAt - Math.floor(Date.now() / 1000);
            }

            let timeRemainingStr = 'Unknown';
            if (timeRemaining !== null) {
                if (timeRemaining <= 0) {
                    timeRemainingStr = 'Expired';
                } else {
                    const days = Math.floor(timeRemaining / 86400);
                    const hours = Math.floor((timeRemaining % 86400) / 3600);
                    const minutes = Math.floor((timeRemaining % 3600) / 60);
                    timeRemainingStr =
                        days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                }
            }

            const userInfo = data.user_info || {};

            const isDisabled = this.disabledIndexes.includes(index);
            const isDomainBlocked = (() => {
                try {
                    return BLOCKED_DOMAINS.includes(new URL(getCodebuddyBaseUrl(data.base_url)).host);
                } catch {
                    return false;
                }
            })();

            // 冷却态（isRateLimited 顺带惰性清理过期标记）
            const isRateLimited = this.isRateLimited(index);
            const cooldown = isRateLimited ? this.rateLimitedIndexes.get(index) : null;
            const rateLimitUntil = cooldown ? cooldown.expiry : null;
            const rateLimitRemainingMs = cooldown ? Math.max(0, cooldown.expiry - Date.now()) : 0;
            const rateLimitReason = cooldown ? cooldown.reason : null;

            // 不可路由原因（优先级：域名废弃 > 禁用 > 冷却 > 过期），null 表示可路由
            let unroutableReason = null;
            if (isDomainBlocked) unroutableReason = 'domain-blocked';
            else if (isDisabled) unroutableReason = 'disabled';
            else if (isRateLimited) unroutableReason = 'rate-limited';
            else if (isExpired) unroutableReason = 'expired';

            // 模型级冷却清单（账号仍可用，仅这些模型被锁；顺带惰性清理过期项）
            const nowMs = Date.now();
            const modelCooldowns = [];
            for (const [key, expiry] of this.modelCooldowns) {
                const sep = String(key).indexOf(':');
                if (Number(String(key).slice(0, sep)) !== index) continue;
                if (nowMs >= expiry) {
                    this.modelCooldowns.delete(key);
                    continue;
                }
                const remainingMs = expiry - nowMs;
                modelCooldowns.push({
                    model: String(key).slice(sep + 1),
                    remainingMs,
                    remainingStr: formatDuration(remainingMs)
                });
            }
            modelCooldowns.sort((a, b) => a.remainingMs - b.remainingMs);

            // 窗口内连续失败计数（未达阈值；达阈值则已转入账号级冷却）
            const failureStreak = this.failureStreaks.get(index)?.count || 0;

            return {
                index,
                filename,
                userId: data.user_id || 'unknown',
                email: userInfo.email || data.user_id,
                name: userInfo.name,
                createdAt: data.created_at,
                expiresIn: data.expires_in,
                expiresAt,
                timeRemaining,
                timeRemainingStr,
                isExpired,
                isDisabled,
                isDomainBlocked,
                isRateLimited,
                rateLimitUntil,
                rateLimitRemainingMs,
                rateLimitRemainingStr: isRateLimited ? formatDuration(rateLimitRemainingMs) : '—',
                rateLimitReason,
                modelCooldowns,
                failureStreak,
                breakerThreshold: TenantTokenManager.BREAKER_THRESHOLD,
                priorityRank: this.priorityOrder.length > 0
                    ? this.priorityOrder.indexOf(filename)
                    : -1,
                isManualSelected: index === this.manualSelectedIndex,
                isCurrentRotation: index === this.currentIndex,
                isRoutable: unroutableReason === null,
                unroutableReason,
                tokenType: data.token_type || 'Bearer',
                scope: data.scope,
                domain: data.domain,
                hasRefreshToken: !!data.refresh_token,
                baseUrl: getCodebuddyBaseUrl(data.base_url),
                enterpriseId: data.enterprise_id || '',
                enterpriseName: data.enterprise_name || '',
                departmentInfo: data.department_info || ''
            };
        });

        // 排过优先级就按优先级顺序返回面板：前端直接按数组顺序渲染，
        // 若这里仍按文件加载顺序给出，拖完松手后 loadCredentials 会把顺序排回去，
        // 用户看到的就是"拖了但没生效"。
        // index 保留原始下标不动 —— 删除/禁用/设活跃都靠它定位。
        if (this.priorityOrder.length > 0) {
            list.sort((a, b) => a.priorityRank - b.priorityRank);
        }
        return list;
    }

    /**
     * 获取轮换摘要（供管理面板标题徽标使用）
     * @returns {{currentIndex: number, manualSelectedIndex: number|null, autoRotationEnabled: boolean, rotationCount: number, rateLimitedCount: number}}
     */
    getRotationInfo() {
        return {
            currentIndex: this.currentIndex,
            manualSelectedIndex: this.manualSelectedIndex,
            autoRotationEnabled: this.autoRotationEnabled,
            rotationCount: this.rotationCount,
            rateLimitedCount: this.rateLimitedIndexes.size,
            modelCooldownCount: this.modelCooldowns.size,
            priorityOrderEnabled: this.priorityOrder.length > 0
        };
    }

    /**
     * 获取当前凭证信息
     * @returns {Object}
     */
    getCurrentCredentialInfo() {
        if (this.credentials.length === 0) {
            return {status: 'no_credentials'};
        }

        if (
            this.manualSelectedIndex !== null &&
            this.manualSelectedIndex >= 0 &&
            this.manualSelectedIndex < this.credentials.length
        ) {
            const credential = this.credentials[this.manualSelectedIndex];
            return {
                status: 'manual_selected',
                index: this.manualSelectedIndex,
                filename: basename(credential.filePath),
                userId: credential.data.user_id || 'unknown'
            };
        }

        if (this.currentIndex < 0 || this.currentIndex >= this.credentials.length) {
            this.currentIndex = 0;
        }

        if (!this.autoRotationEnabled) {
            const credential = this.credentials[this.currentIndex];
            return {
                status: 'auto_rotation_disabled',
                index: this.currentIndex,
                filename: basename(credential.filePath),
                userId: credential.data.user_id || 'unknown',
                rotationCount: this.rotationCount,
                autoRotationEnabled: false
            };
        }

        const credential = this.credentials[this.currentIndex];
        return {
            status: 'auto_rotation',
            index: this.currentIndex,
            filename: basename(credential.filePath),
            userId: credential.data.user_id || 'unknown',
            usageCount: this.usageCount,
            rotationCount: this.rotationCount,
            autoRotationEnabled: true
        };
    }

    /**
     * 检查是否有可用凭证
     * @returns {boolean}
     */
    hasCredentials() {
        return this.credentials.length > 0;
    }

    /**
     * 从磁盘重新加载所有凭证和状态（多进程同步用）
     */
    reload() {
        this.loadAllTokens();
        this.loadState();
    }
}

export {TenantTokenManager};
