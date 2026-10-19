/**
 * Relay API 调用模块
 * 向上游 LLM API 发送请求，支持 per-upstream 代理（HTTP/HTTPS/SOCKS5）及 agent 缓存
 * 支持 Responses API WebSocket 模式
 * @module services/relay/api
 */

import {request, readBody} from '../../utils/http-client.js';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import {buildUrl} from '../../utils/helpers.js';
import {normalizePayload} from '../../transformer/shared-translator.js';
import {ResponsesWSPool} from '../ws/ws-pool.js';
import {connectWebSocket, ResponsesWSError, sendRequest} from '../ws/ws-client.js';
import logger from '../../utils/logger.js';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Relay 上游错误
 * 保留上游 HTTP 状态码，便于路由层区分 429 等特殊状态
 */
export class RelayUpstreamError extends Error {
    /**
     * @param {number} status - 上游 HTTP 状态码
     * @param {string} message - 错误信息
     */
    constructor(status, message) {
        super(message);
        this.name = 'RelayUpstreamError';
        this.status = status;
    }
}

// ==================== 代理 Agent 缓存 ====================

/**
 * 按 proxy URL 缓存的 agent 实例，避免每次请求重复创建
 * @type {Map<string, HttpsProxyAgent|SocksProxyAgent>}
 */
const proxyAgentCache = new Map();

/**
 * 获取代理 Agent（带缓存）
 * - 代理 URL 为空或 falsy 时返回 undefined（直连）
 * - socks5:// / socks4:// 开头使用 SocksProxyAgent
 * - http:// / https:// 开头使用 HttpsProxyAgent
 *
 * @param {string} [proxyUrl] - 代理地址
 * @param {boolean} [rejectUnauthorized=true] - 是否校验 TLS 证书
 * @returns {HttpsProxyAgent|SocksProxyAgent|undefined}
 */
export function getProxyAgent(proxyUrl, rejectUnauthorized = true) {
    if (!proxyUrl) {
        return undefined;
    }

    // 命中缓存（区分 TLS 校验模式）
    const cacheKey = `${proxyUrl}:${rejectUnauthorized ? 'tls-verify' : 'tls-skip'}`;
    if (proxyAgentCache.has(cacheKey)) {
        return proxyAgentCache.get(cacheKey);
    }

    let agent;
    try {
        const agentOptions = {rejectUnauthorized};
        if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks://')) {
            agent = new SocksProxyAgent(proxyUrl, agentOptions);
        } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
            agent = new HttpsProxyAgent(proxyUrl, agentOptions);
        } else {
            logger.warn(`Relay API: 不支持的代理协议 "${proxyUrl}"，将直连`);
            return undefined;
        }

        proxyAgentCache.set(cacheKey, agent);
        return agent;
    } catch (err) {
        logger.error(`Relay API: 创建代理 Agent 失败 (${proxyUrl}): ${err.message}`);
        return undefined;
    }
}

// ==================== 协议感知 ====================

/**
 * 判断上游是否指向本地 Copilot 端点
 */
function isLocalCopilotUpstream(base_url) {
    try {
        const url = new URL(base_url);
        return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname.includes('/copilot');
    } catch {
        return false;
    }
}

export function buildProtocolAwareUrl(upstream, endpoint) {
    return buildUrl(upstream.base_url, endpoint);
}

export function normalizeUpstreamProtocol(protocol) {
    const normalized = String(protocol || '').trim().toLowerCase();
    return normalized || 'openai';
}

export function isAnthropicUpstream(upstream) {
    return normalizeUpstreamProtocol(upstream?.protocol) === 'anthropic';
}

export function isResponsesUpstream(upstream) {
    return normalizeUpstreamProtocol(upstream?.protocol) === 'responses';
}

// ==================== 请求辅助 ====================

function buildBaseHeaders(upstream, extraHeaders = {}) {
    const headers = {
        'User-Agent': 'Relay/1.0',
        ...extraHeaders
    };

    if (isAnthropicUpstream(upstream)) {
        headers.Authorization = `Bearer ${upstream.api_key}`;
        headers['anthropic-version'] = extraHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION;
        return headers;
    }

    headers.Authorization = `Bearer ${upstream.api_key}`;
    return headers;
}

function applyProxyAndCopilot(upstream, headers, options) {
    if (isLocalCopilotUpstream(upstream.base_url) && upstream.proxy && !isAnthropicUpstream(upstream)) {
        headers['X-Copilot-Proxy'] = upstream.proxy;
    }

    const rejectUnauthorized = upstream.skip_tls_verify !== true;

    const proxyAgent = getProxyAgent(upstream.proxy, rejectUnauthorized);
    if (proxyAgent) {
        options.agent = proxyAgent;
    }

    options.rejectUnauthorized = rejectUnauthorized;
}

async function requestJson(url, upstream, {method = 'POST', headers = {}, body, timeout = 300000} = {}) {
    const finalHeaders = buildBaseHeaders(upstream, headers);
    const options = {
        method,
        headers: finalHeaders,
        timeout
    };

    if (body !== undefined) {
        options.body = body;
    }

    applyProxyAndCopilot(upstream, finalHeaders, options);
    return request(url, options);
}

// ==================== Chat Completions ====================

/**
 * 向上游发送 OpenAI 格式的聊天请求
 *
 * @param {object} payload - OpenAI chat completions 请求体
 * @param {object} upstream - 上游配置
 * @param {string} upstream.name - 上游名称
 * @param {string} upstream.base_url - 上游基础 URL
 * @param {string} upstream.api_key - 上游 API Key
 * @param {string} [upstream.proxy] - 代理地址
 * @param {boolean} [upstream.enabled] - 是否启用
 * @returns {Promise<{status: number, headers: object, body: import('stream').Readable}>}
 * @throws {Error} 上游返回非 2xx 时抛出包含响应体的错误
 */
export async function createChatCompletions(payload, upstream, meta = {}) {
    const url = buildProtocolAwareUrl(upstream, 'v1/chat/completions');

    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    const reasoningEffort = payload.reasoning_effort || 'high';
    logger.info(
        `[${upstream.name}]: ${upstream.base_url}, model: ${payload.model || 'unknown'}, effort: ${reasoningEffort}, proxy: ${proxyMode}`
    );

    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(normalizePayload(payload, {source: 'relay', upstream: upstream.name})),
        timeout: 300000
    });

    // 非 2xx 时读取响应体并抛出异常
    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        logger.error(`[${upstream.name}] 上游返回 HTTP ${response.status}: ${errorMsg.slice(0, 300)}`);
        throw new RelayUpstreamError(response.status, `[${upstream.name}]: 上游返回 HTTP ${response.status}: ${errorMsg}`);
    }

    return response;
}

// ==================== Responses API ====================

export async function createResponses(payload, upstream, meta = {}, endpoint = 'v1/responses') {
    const url = buildProtocolAwareUrl(upstream, endpoint);
    const proxyMode = upstream.proxy ? upstream.proxy : '直连';

    logger.info(
        `[${upstream.name}]: ${url}, model: ${payload.model || 'unknown'}, protocol: responses, proxy: ${proxyMode}`
    );

    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        timeout: 300000
    });

    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        logger.error(`[${upstream.name}] Responses 上游返回 HTTP ${response.status}: ${errorMsg.slice(0, 300)}`);
        throw new RelayUpstreamError(response.status, `[${upstream.name}]: Responses 上游返回 HTTP ${response.status}: ${errorMsg}`);
    }

    return response;
}

// ==================== Anthropic Protocol ====================

export async function createAnthropicMessages(payload, upstream, meta = {}, requestHeaders = {}) {
    const url = buildProtocolAwareUrl(upstream, 'v1/messages');
    const proxyMode = upstream.proxy ? upstream.proxy : '直连';

    logger.info(
        `[${upstream.name}]: ${url}, model: ${payload.model || 'unknown'}, protocol: anthropic, proxy: ${proxyMode}`
    );

    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'anthropic-version': requestHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
            ...(requestHeaders['anthropic-beta'] ? {'anthropic-beta': requestHeaders['anthropic-beta']} : {})
        },
        body: JSON.stringify(payload),
        timeout: 300000
    });

    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        logger.error(`[${upstream.name}] Anthropic 上游返回 HTTP ${response.status}: ${errorMsg.slice(0, 300)}`);
        throw new RelayUpstreamError(response.status, `[${upstream.name}]: Anthropic 上游返回 HTTP ${response.status}: ${errorMsg}`);
    }

    return response;
}

export async function createAnthropicCountTokens(payload, upstream, requestHeaders = {}) {
    const url = buildProtocolAwareUrl(upstream, 'v1/messages/count_tokens');
    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'anthropic-version': requestHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
            ...(requestHeaders['anthropic-beta'] ? {'anthropic-beta': requestHeaders['anthropic-beta']} : {})
        },
        body: JSON.stringify(payload),
        timeout: 30000
    });

    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        throw new RelayUpstreamError(response.status, `[${upstream.name}]: count_tokens 失败 HTTP ${response.status}: ${errorMsg}`);
    }

    return response;
}

// ==================== 获取上游模型列表 ====================

/**
 * 从上游获取模型列表
 *
 * @param {object} upstream - 上游配置
 * @param {string} upstream.base_url - 上游基础 URL
 * @param {string} upstream.api_key - 上游 API Key
 * @param {string} [upstream.proxy] - 代理地址
 * @returns {Promise<object>} 解析后的 /models 响应 JSON
 * @throws {Error} 请求失败或响应无法解析时抛出
 */
export async function getUpstreamModels(upstream, requestHeaders = {}) {
    const url = buildProtocolAwareUrl(upstream, 'v1/models');

    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    logger.info(`[${upstream.name}]:GET ${url} proxy=${proxyMode}`);

    const response = await requestJson(url, upstream, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            ...(isAnthropicUpstream(upstream)
                ? {
                      'anthropic-version': requestHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
                      ...(requestHeaders['anthropic-beta'] ? {'anthropic-beta': requestHeaders['anthropic-beta']} : {})
                  }
                : {})
        },
        timeout: 15000
    });

    // 非 2xx 时读取响应体并抛出异常
    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        throw new RelayUpstreamError(response.status, `[${upstream.name}]:获取模型列表失败 HTTP ${response.status}: ${errorMsg}`);
    }

    const body = await readBody(response.body);
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error(`[${upstream.name}]:模型列表响应 JSON 解析失败: ${e.message}`);
    }
}

// ==================== WebSocket 上游支持 ====================

const relayWSPool = new ResponsesWSPool({maxPerKey: 5, idleTimeout: 60000});

/**
 * 判断上游是否启用 WS 模式
 */
export function isWSUpstream(upstream) {
    return upstream.ws === true && isResponsesUpstream(upstream);
}

/**
 * 从上游 base_url 推导 WS URL
 */
export function buildWSUrl(upstream) {
    const httpUrl = buildUrl(upstream.base_url, 'v1/responses');
    return httpUrl.replace('https://', 'wss://').replace('http://', 'ws://');
}

/**
 * 构建 WS 连接头
 */
export function buildWSHeaders(upstream) {
    return {
        'Authorization': `Bearer ${upstream.api_key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Relay/1.0'
    };
}

/**
 * 计算上游 WS 连接池键
 */
function _connectionPoolKey(upstream) {
    let hash = 0;
    const key = upstream.api_key || '';
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return `${upstream.base_url}:${hash.toString(36)}`;
}

/**
 * 通过 WS 连接上游发送 Responses 请求
 * @param {object} payload - Responses API 请求体
 * @param {object} upstream - 上游配置
 * @param {object} [options] - 选项
 * @param {string} [options.contextKey] - 会话上下文键
 * @returns {Promise<{eventStream: AsyncIterable, conn: object}>}
 */
export async function createResponsesWS(payload, upstream, options = {}) {
    const poolKey = _connectionPoolKey(upstream);

    const connectFn = async () => {
        const wsUrl = buildWSUrl(upstream);
        const headers = buildWSHeaders(upstream);
        const rejectUnauthorized = upstream.skip_tls_verify !== true;
        const proxyAgent = getProxyAgent(upstream.proxy, rejectUnauthorized);
        logger.info(`Relay WS: creating new connection to ${wsUrl}`);
        return connectWebSocket(wsUrl, headers, proxyAgent, undefined, rejectUnauthorized);
    };

    const conn = await relayWSPool.acquire(poolKey, connectFn, {
        contextKey: options.contextKey,
        preferredPreviousResponseId: payload.previous_response_id
    });

    const eventStream = sendRequest(conn, payload);
    return {eventStream, conn};
}

export function releaseWSConnection(conn) {
    relayWSPool.release(conn);
}

export function discardWSConnection(conn) {
    relayWSPool.discard(conn);
}

export function shutdownWSPool() {
    relayWSPool.shutdown();
}

export {ResponsesWSError};
