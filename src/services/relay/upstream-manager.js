/**
 * 上游配置管理器
 * 管理多个上游配置（base_url + api_key + proxy）、活跃上游手动切换
 * 使用文件存储（upstreams.json、settings.json）
 * @module services/relay/upstream-manager
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'fs';
import {join} from 'path';
import {
    isWSUpstream,
    createChatCompletions, createResponses, createResponsesWS,
    createAnthropicMessages,
    releaseWSConnection, discardWSConnection,
    RelayUpstreamError
} from './api.js';
import logger from '../../utils/logger.js';
import {formatDuration} from '../../utils/helpers.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

const UPSTREAMS_FILE = 'upstreams.json';
const SETTINGS_FILE = 'settings.json';

export class UpstreamManager {
    constructor(tenantDir) {
        this.tenantDir = tenantDir;
        this.upstreamsPath = join(tenantDir, UPSTREAMS_FILE);
        this.settingsPath = join(tenantDir, SETTINGS_FILE);
        this.upstreams = [];
        // 活跃上游索引，-1 表示使用第一个启用的上游
        this._activeIndex = -1;

        // 429 限速追踪：index → 限速过期时间戳
        this.rateLimitedIndexes = new Map();

        // 上次返回的上游索引，用于在 429 时标记限速
        this.lastReturnedIndex = null;

        this._loadUpstreams();
        this._loadSettings();
    }

    /** 429 限速默认冷却时间（5分钟） */
    static RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;

    _loadUpstreams() {
        try {
            if (existsSync(this.upstreamsPath)) {
                this.upstreams = JSON.parse(readFileSync(this.upstreamsPath, 'utf8'));
                if (!Array.isArray(this.upstreams)) this.upstreams = [];
            }
        } catch (error) {
            logger.error(`Relay: 加载上游配置失败: ${error.message}`);
            this.upstreams = [];
        }
    }

    _saveUpstreams() {
        try {
            if (!existsSync(this.tenantDir)) mkdirSync(this.tenantDir, {recursive: true});
            writeFileSync(this.upstreamsPath, JSON.stringify(this.upstreams, null, 2), 'utf8');
        } catch (error) {
            logger.error(`Relay: 保存上游配置失败: ${error.message}`);
        }
    }

    _loadSettings() {
        try {
            if (existsSync(this.settingsPath)) {
                const data = JSON.parse(readFileSync(this.settingsPath, 'utf8'));
                if (typeof data.activeIndex === 'number') {
                    this._activeIndex = data.activeIndex;
                }
            }
        } catch (error) {
            logger.error(`Relay: 加载设置失败: ${error.message}`);
        }
    }

    _saveSettings() {
        try {
            if (!existsSync(this.tenantDir)) mkdirSync(this.tenantDir, {recursive: true});
            writeFileSync(this.settingsPath, JSON.stringify({
                activeIndex: this._activeIndex
            }, null, 2), 'utf8');
        } catch (error) {
            logger.error(`Relay: 保存设置失败: ${error.message}`);
        }
    }

    /**
     * 从磁盘重新加载上游配置和设置
     * 解决多进程（cluster）模式下状态不同步的问题
     */
    reload() {
        this._loadUpstreams();
        this._loadSettings();
    }

    /**
     * 列出所有上游配置，标记活跃上游与健康状态
     */
    listUpstreams() {
        // 先惰性清理过期限速标记，确保健康字段反映当前时刻
        this._cleanupRateLimited();
        const activeIdx = this._getActiveIndex();
        return this.upstreams.map((u, i) => {
            const enabled = u.enabled !== false;
            const isRateLimited = this.isRateLimited(i);
            const rateLimitUntil = isRateLimited ? this.rateLimitedIndexes.get(i) : null;
            const rateLimitRemainingMs = isRateLimited ? Math.max(0, rateLimitUntil - Date.now()) : 0;

            // 不可路由原因（优先级：禁用 > 限速），null 表示可路由
            let unroutableReason = null;
            if (!enabled) unroutableReason = 'disabled';
            else if (isRateLimited) unroutableReason = 'rate-limited';

            return {
                index: i,
                name: u.name,
                base_url: u.base_url,
                api_key_preview: u.api_key ? u.api_key.slice(0, 8) + '****' + u.api_key.slice(-4) : '',
                api_key_full: u.api_key || '',
                proxy: u.proxy || '',
                skip_tls_verify: u.skip_tls_verify === true,
                models: u.models || [],
                model_map: u.model_map || {},
                protocol: u.protocol || '',
                ws: u.ws || false,
                enabled,
                created_at: u.created_at,
                is_active: i === activeIdx,
                is_configured_active: i === this._activeIndex,
                is_rate_limited: isRateLimited,
                rate_limit_until: rateLimitUntil,
                rate_limit_remaining_ms: rateLimitRemainingMs,
                rate_limit_remaining_str: isRateLimited ? formatDuration(rateLimitRemainingMs) : '—',
                is_routable: unroutableReason === null,
                unroutable_reason: unroutableReason
            };
        });
    }

    /**
     * 获取实际活跃上游索引（_activeIndex 指向的上游必须启用且未被限速）
     * 如果指定的不启用/被限速或越界，回退到第一个可用的上游
     */
    _getActiveIndex() {
        // 清理过期的限速标记
        this._cleanupRateLimited();

        if (
            this._activeIndex >= 0 &&
            this._activeIndex < this.upstreams.length &&
            this.upstreams[this._activeIndex].enabled !== false &&
            !this.isRateLimited(this._activeIndex)
        ) {
            return this._activeIndex;
        }

        // 活跃上游不可用，找第一个启用且未被限速的上游
        const idx = this.upstreams.findIndex((u) => u.enabled !== false && !this.isRateLimited(this.upstreams.indexOf(u)));
        if (idx >= 0) return idx;

        // 所有上游都被限速，清除限速标记后重试
        if (this.rateLimitedIndexes.size > 0) {
            logger.warn('Relay: All upstreams rate-limited, clearing rate limits');
            this.rateLimitedIndexes.clear();
            return this.upstreams.findIndex((u) => u.enabled !== false);
        }

        return -1;
    }

    /**
     * 设置活跃上游
     * @param {number} index - 上游索引
     */
    setActiveUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) return false;
        if (this.upstreams[index].enabled === false) return false;
        this._activeIndex = index;
        // 切换活跃上游时清除所有限速标记，立即生效
        this.rateLimitedIndexes.clear();
        logger.info(`Relay: 活跃上游已切换为「${this.upstreams[index].name}」(index: ${index})`);
        this._saveSettings();
        broadcast('relay-settings-changed').catch(() => {});
        return true;
    }

    /**
     * 获取当前活跃上游
     * 每次调用时从磁盘重新加载状态，确保多进程间状态一致
     * @returns {Object|null} {name, base_url, api_key, proxy, enabled, index}
     */
    getActiveUpstream() {
        this.reload();
        const idx = this._getActiveIndex();
        if (idx < 0) {
            this.lastReturnedIndex = null;
            return null;
        }
        this.lastReturnedIndex = idx;
        return {...this.upstreams[idx], index: idx};
    }

    /**
     * 获取所有启用的上游（活跃上游排在最前），用于故障转移
     * @returns {Array<{name, base_url, api_key, proxy, enabled, index}>}
     */
    getEnabledUpstreams() {
        const enabled = this.upstreams.map((u, i) => ({...u, index: i})).filter((u) => u.enabled !== false);
        const activeIdx = this._getActiveIndex();
        if (activeIdx < 0) return enabled;
        const activeItem = enabled.find((u) => u.index === activeIdx);
        if (!activeItem) return enabled;
        return [activeItem, ...enabled.filter((u) => u.index !== activeIdx)];
    }

    /**
     * 惰性清理过期的限速标记
     */
    _cleanupRateLimited() {
        if (this.rateLimitedIndexes.size === 0) return;
        const now = Date.now();
        for (const [index, expiry] of this.rateLimitedIndexes) {
            if (now >= expiry) {
                this.rateLimitedIndexes.delete(index);
                logger.debug(`Relay: Rate limit expired for upstream #${index}`);
            }
        }
    }

    /**
     * 标记上游为 429 限速
     * @param {number} index - 上游索引
     * @param {number} [durationMs] - 限速持续时间（毫秒），默认 5 分钟
     */
    markRateLimited(index, durationMs) {
        if (index < 0 || index >= this.upstreams.length) return;
        const duration = durationMs || UpstreamManager.RATE_LIMIT_COOLDOWN;
        const expiry = Date.now() + duration;
        this.rateLimitedIndexes.set(index, expiry);
        logger.warn(`Relay: Upstream #${index} (${this.upstreams[index].name}) marked as rate-limited for ${Math.round(duration / 1000)}s`);
    }

    /**
     * 检查上游是否处于限速期
     * @param {number} index - 上游索引
     * @returns {boolean}
     */
    isRateLimited(index) {
        const expiry = this.rateLimitedIndexes.get(index);
        if (!expiry) return false;
        if (Date.now() >= expiry) {
            this.rateLimitedIndexes.delete(index);
            return false;
        }
        return true;
    }

    /**
     * 重置单项上游的限速状态（区别于 setActiveUpstream 的"清空全部"语义）
     * 仅清除目标 index 的冷却标记
     * 本方法不触发 broadcast（由调用方按需广播），避免集群广播往返风暴
     * @param {number} index - 上游索引
     * @returns {{ok: boolean, wasRateLimited: boolean, reason?: string}}
     */
    resetRateLimit(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.upstreams.length) {
            return {ok: false, wasRateLimited: false, reason: 'invalid-index'};
        }

        const wasRateLimited = this.rateLimitedIndexes.has(index);
        this.rateLimitedIndexes.delete(index);

        logger.info(`Relay: Upstream #${index} 限速状态已重置 (wasLimited=${wasRateLimited})`);
        return {ok: true, wasRateLimited};
    }

    /**
     * 平移限速索引（上游数组增删后调用）
     * @param {number} removedIndex - 被删除的上游索引
     */
    _shiftRateLimitedIndexes(removedIndex) {
        if (this.rateLimitedIndexes.size === 0) return;
        const shifted = new Map();
        for (const [key, expiry] of this.rateLimitedIndexes) {
            if (key === removedIndex) continue;
            shifted.set(key > removedIndex ? key - 1 : key, expiry);
        }
        this.rateLimitedIndexes = shifted;
    }

    /**
     * 标记上次使用的上游为 429 限速
     * @param {number} [durationMs] - 限速持续时间（毫秒），默认 5 分钟
     */
    markLastReturnedRateLimited(durationMs) {
        if (this.lastReturnedIndex !== null) {
            this.markRateLimited(this.lastReturnedIndex, durationMs);
        }
    }

    /**
     * 记录上游请求成功（当前为空操作，保留接口）
     */
    recordSuccess(_index) {}

    /**
     * 记录上游请求失败（当前为空操作，保留接口）
     */
    recordFailure(_index, _reason) {}

    /**
     * 解析请求模型名到该上游实际使用的模型名
     * 1. model_map 精确匹配
     * 2. 以上都不匹配则透传原始模型名
     */
    resolveModel(requestedModel, upstreamIndex) {
        if (upstreamIndex < 0 || upstreamIndex >= this.upstreams.length) return requestedModel;
        const upstream = this.upstreams[upstreamIndex];

        // 1. model_map 精确匹配
        if (upstream.model_map && typeof upstream.model_map === 'object') {
            const mapped = upstream.model_map[requestedModel];
            if (mapped) {
                return mapped;
            }
        }

        // 2. 透传
        return requestedModel;
    }

    addUpstream(data) {
        const upstream = {
            name: data.name || 'Unnamed',
            base_url: data.base_url || '',
            api_key: data.api_key || '',
            proxy: data.proxy || '',
            skip_tls_verify: data.skip_tls_verify === true,
            models: data.models || [],
            model_map: data.model_map || {},
            protocol: data.protocol || '',
            ws: data.ws === true,
            enabled: data.enabled !== false,
            created_at: Math.floor(Date.now() / 1000)
        };
        if (!upstream.base_url) {
            throw new Error('base_url is required');
        }
        this.upstreams.push(upstream);
        this._saveUpstreams();
        broadcast('relay-upstreams-changed').catch(() => {});
        return {index: this.upstreams.length - 1, ...upstream};
    }

    updateUpstream(index, data) {
        if (index < 0 || index >= this.upstreams.length) return null;
        const upstream = this.upstreams[index];
        if (data.name !== undefined) upstream.name = data.name;
        if (data.base_url !== undefined) upstream.base_url = data.base_url;
        if (data.api_key !== undefined) upstream.api_key = data.api_key;
        if (data.proxy !== undefined) upstream.proxy = data.proxy;
        if (data.skip_tls_verify !== undefined) upstream.skip_tls_verify = data.skip_tls_verify === true;
        if (data.enabled !== undefined) upstream.enabled = data.enabled;
        if (data.models !== undefined) upstream.models = data.models;
        if (data.model_map !== undefined) upstream.model_map = data.model_map;
        if (data.protocol !== undefined) upstream.protocol = data.protocol;
        if (data.ws !== undefined) upstream.ws = data.ws;
        this._saveUpstreams();
        broadcast('relay-upstreams-changed').catch(() => {});
        return {index, ...upstream};
    }

    deleteUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) return false;
        this.upstreams.splice(index, 1);
        // 修正活跃索引
        if (this._activeIndex === index) {
            this._activeIndex = -1;
        } else if (this._activeIndex > index) {
            this._activeIndex--;
        }
        // 同步平移限速索引，避免下标错位产生"幽灵冷却"
        this._shiftRateLimitedIndexes(index);
        if (this.lastReturnedIndex !== null) {
            if (this.lastReturnedIndex === index) this.lastReturnedIndex = null;
            else if (this.lastReturnedIndex > index) this.lastReturnedIndex--;
        }
        this._saveUpstreams();
        this._saveSettings();
        broadcast('relay-upstreams-changed').catch(() => {});
        return true;
    }

    async testUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) {
            return {success: false, message: '无效的上游索引'};
        }
        const upstream = this.upstreams[index];

        // 优先用 model_map 的第一个 value，其次 models[0]
        // 不调用上游 /v1/models 接口（部分厂商该接口计费或不开放）
        let model = null;
        if (upstream.model_map && typeof upstream.model_map === 'object') {
            const values = Object.values(upstream.model_map);
            if (values.length > 0) model = values[0];
        }
        if (!model) {
            model = upstream.models?.[0];
        }
        if (!model) {
            return {success: false, message: '未配置模型：请在 model_map 或 models 中填写至少一个模型名'};
        }

        const protocol = upstream.protocol || 'openai';
        const wsMode = protocol === 'responses' && isWSUpstream(upstream);

        try {
            if (protocol === 'anthropic') {
                await this._testAnthropic(upstream, model);
            } else if (protocol === 'responses') {
                await this._testResponses(upstream, model);
            } else {
                // 默认 openai 协议
                await this._testOpenAI(upstream, model);
            }

            const wsInfo = wsMode ? ', ws: true' : '';
            return {success: true, message: `连接成功 (protocol: ${protocol}${wsInfo}, model: ${model})`};
        } catch (err) {
            // RelayUpstreamError 包含上游返回的 HTTP 状态码和错误信息
            if (err instanceof RelayUpstreamError) {
                return {success: false, message: `HTTP ${err.status}: ${err.message.slice(0, 300)}`};
            }
            return {success: false, message: err.message};
        }
    }

    /**
     * OpenAI 协议测试：复用 createChatCompletions，确保 URL 构建与正常请求一致
     */
    async _testOpenAI(upstream, model) {
        const payload = {
            model,
            messages: [{role: 'user', content: 'hi'}],
            max_completion_tokens: 1,
            stream: false
        };
        await createChatCompletions(payload, upstream);
    }

    /**
     * Anthropic 协议测试：复用 createAnthropicMessages，确保 URL 构建与正常请求一致
     */
    async _testAnthropic(upstream, model) {
        const payload = {
            model,
            max_tokens: 1,
            stream: false,
            messages: [{role: 'user', content: 'hi'}]
        };
        await createAnthropicMessages(payload, upstream);
    }

    /**
     * Responses 协议测试
     * WS 模式：先建立 WebSocket 连接再通过 WS 发送请求
     * HTTP 模式：复用 createResponses，确保 URL 构建与正常请求一致
     */
    async _testResponses(upstream, model) {
        // WS 模式：先连接 WebSocket，再发送请求
        if (isWSUpstream(upstream)) {
            return await this._testResponsesWS(upstream, model);
        }

        // 普通 HTTP 模式：复用 createResponses
        const payload = {
            model,
            input: 'hi',
            max_output_tokens: 16,
            stream: false
        };
        await createResponses(payload, upstream);
    }

    /**
     * Responses WS 模式测试：通过连接池获取/复用 WS 连接，发送一次最小请求
     * 成功正常返回，失败抛 RelayUpstreamError 或 Error
     */
    async _testResponsesWS(upstream, model) {
        const payload = {
            model,
            input: 'hi',
            max_output_tokens: 16
        };

        let conn = null;
        let shouldDiscard = false;
        try {
            // 通过连接池获取（可复用空闲连接，避免每次新建）
            const {eventStream, conn: acquired} = await createResponsesWS(payload, upstream);
            conn = acquired;

            let completed = false;
            let errorEvent = null;

            for await (const event of eventStream) {
                if (event.type === 'response.completed') {
                    completed = true;
                    break;
                }
                if (event.type === 'error') {
                    errorEvent = event;
                    break;
                }
            }

            if (errorEvent) {
                shouldDiscard = true;
                const errMsg = errorEvent.data?.error?.message || 'WS request error';
                const errStatus = errorEvent.data?.error?.status || 500;
                throw new RelayUpstreamError(errStatus, `WS error: ${errMsg}`);
            }

            if (!completed) {
                shouldDiscard = true;
                throw new RelayUpstreamError(500, 'WS stream ended without completion');
            }
            // 成功，正常返回（连接归还池中）
        } catch (err) {
            if (!(err instanceof RelayUpstreamError)) {
                shouldDiscard = true;
            }
            if (err instanceof RelayUpstreamError) throw err;
            throw new Error(`WS 连接失败: ${err.message}`);
        } finally {
            if (conn) {
                if (shouldDiscard) discardWSConnection(conn);
                else releaseWSConnection(conn);
            }
        }
    }

    getEnabledCount() {
        return this.upstreams.filter((u) => u.enabled !== false).length;
    }

    getCount() {
        return this.upstreams.length;
    }
}
