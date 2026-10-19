/**
 * Copilot API 服务
 * @module services/copilot/copilot-api
 */

import { request, readBody } from '../../utils/http-client.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getCopilotBaseUrl, copilotHeaders } from './config.js';
import { normalizePayload } from '../../transformer/shared-translator.js';
import logger from '../../utils/logger.js';
import {acquire, release, discard, sendRequest} from './copilot-ws-pool.js';

// ==================== 代理 Agent 缓存 ====================

const proxyAgentCache = new Map();

function requestNetworkOptions(proxyUrl, networkOptions = {}) {
    const options = {};
    if (proxyUrl) options.proxyUrl = proxyUrl;
    if (typeof networkOptions.rejectUnauthorized === 'boolean') {
        options.rejectUnauthorized = networkOptions.rejectUnauthorized;
    }
    return options;
}

function createProxyAgent(proxyUrl, rejectUnauthorized = true) {
    if (!proxyUrl) return undefined;
    const cacheKey = `${proxyUrl}:${rejectUnauthorized === false ? 'tls-skip' : 'tls-verify'}`;
    if (proxyAgentCache.has(cacheKey)) return proxyAgentCache.get(cacheKey);
    let agent;
    try {
        const agentOptions = {rejectUnauthorized};
        if (proxyUrl.startsWith('socks')) {
            agent = new SocksProxyAgent(proxyUrl, agentOptions);
        } else {
            agent = new HttpsProxyAgent(proxyUrl, agentOptions);
        }
        proxyAgentCache.set(cacheKey, agent);
        return agent;
    } catch (err) {
        logger.warn(`Copilot: 代理配置失败: ${err.message}`);
        return undefined;
    }
}

/**
 * 获取可用模型列表
 * @param {string} copilotToken - Copilot token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {string} accountType - 账户类型
 * @param {string} [proxyUrl] - 代理地址
 * @param {object} [networkOptions] - 网络选项
 * @returns {Promise<object>}
 */
export async function getModels(copilotToken, vsCodeVersion, accountType = 'individual', proxyUrl, networkOptions = {}) {
    const baseUrl = getCopilotBaseUrl(accountType);
    const options = {
        method: 'GET',
        headers: copilotHeaders(copilotToken, vsCodeVersion),
        ...requestNetworkOptions(proxyUrl, networkOptions)
    };

    const response = await request(`${baseUrl}/models`, options);

    if (response.status !== 200) {
        throw new Error(`Failed to get models: ${response.status}`);
    }

    const body = await readBody(response.body);
    return JSON.parse(body);
}

/**
 * 创建 chat completions
 * @param {string} copilotToken - Copilot token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {object} payload - 请求负载
 * @param {string} accountType - 账户类型
 * @param {string} [proxyUrl] - 代理地址
 * @param {object} [networkOptions] - 网络选项
 * @returns {Promise<{body: ReadableStream, headers: object, status: number}>}
 */
export async function createChatCompletions(copilotToken, vsCodeVersion, payload, accountType = 'individual', proxyUrl, networkOptions = {}) {
    const baseUrl = getCopilotBaseUrl(accountType);

    // 检查是否启用 vision
    const enableVision = payload.messages?.some(
        msg => Array.isArray(msg.content) &&
               msg.content.some(c => c.type === 'image_url')
    );

    // 检查是否为 agent 调用
    const isAgentCall = payload.messages?.some(
        msg => ['assistant', 'tool'].includes(msg.role)
    );

    const headers = {
        ...copilotHeaders(copilotToken, vsCodeVersion, enableVision),
        'X-Initiator': isAgentCall ? 'agent' : 'user'
    };

    const options = {
        method: 'POST',
        headers,
        body: JSON.stringify(normalizePayload(payload, {source: 'copilot', upstream: baseUrl})),
        ...requestNetworkOptions(proxyUrl, networkOptions)
    };

    const response = await request(`${baseUrl}/chat/completions`, options);

    if (response.status >= 400) {
        const errorBody = await readBody(response.body);
        logger.error('Failed to create chat completions:', errorBody);
        throw new Error(`Failed to create chat completions: ${response.status} - ${errorBody}`);
    }

    return response;
}

/**
 * 创建 embeddings
 * @param {string} copilotToken - Copilot token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {object} payload - 请求负载
 * @param {string} accountType - 账户类型
 * @returns {Promise<object>}
 */
export async function createEmbeddings(copilotToken, vsCodeVersion, payload, accountType = 'individual', proxyUrl, networkOptions = {}) {
    const baseUrl = getCopilotBaseUrl(accountType);

    const options = {
        method: 'POST',
        headers: copilotHeaders(copilotToken, vsCodeVersion),
        body: JSON.stringify(payload),
        ...requestNetworkOptions(proxyUrl, networkOptions)
    };

    const response = await request(`${baseUrl}/embeddings`, options);

    if (response.status !== 200) {
        const errorBody = await readBody(response.body);
        logger.error('Failed to create embeddings:', errorBody);
        throw new Error(`Failed to create embeddings: ${response.status}`);
    }

    const body = await readBody(response.body);
    return JSON.parse(body);
}

export async function createResponsesWS(copilotToken, vsCodeVersion, payload, accountType = 'individual', proxyUrl, options = {}) {
    const rejectUnauthorized = options.rejectUnauthorized !== false;
    const agent = createProxyAgent(proxyUrl, rejectUnauthorized);
    const networkKey = `${proxyUrl || 'direct'}:${rejectUnauthorized ? 'tls-verify' : 'tls-skip'}`;
    const conn = await acquire(
        copilotToken,
        vsCodeVersion,
        accountType,
        agent,
        rejectUnauthorized,
        options.contextKey,
        payload.previous_response_id,
        networkKey
    );
    const eventStream = sendRequest(conn, payload);
    return {eventStream, conn};
}

export function releaseWSConnection(conn) {
    release(conn);
}

export function discardWSConnection(conn) {
    discard(conn);
}
