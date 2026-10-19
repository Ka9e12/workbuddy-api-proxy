/**
 * Copilot WebSocket 连接池
 * 基于 ResponsesWSPool 实现，提供 Copilot 特定的连接创建逻辑
 * @module services/copilot/copilot-ws-pool
 */

import {ResponsesWSPool} from '../ws/ws-pool.js';
import {connectWebSocket} from './copilot-ws-client.js';
import {wsHeaders, getCopilotBaseUrl} from './config.js';
import logger from '../../utils/logger.js';

// Copilot 专用 WS 连接池实例
const copilotPool = new ResponsesWSPool({maxPerKey: 5, idleTimeout: 60000});

function tokenKey(copilotToken) {
    let hash = 0;
    for (let i = 0; i < copilotToken.length; i++) {
        hash = ((hash << 5) - hash + copilotToken.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}

export function connectionPoolKey(copilotToken, proxyKey) {
    return `${tokenKey(copilotToken)}:${proxyKey || 'direct'}`;
}

/**
 * 获取一个 Copilot WS 连接（复用或新建）
 */
export async function acquire(copilotToken, vsCodeVersion, accountType = 'individual', agent, rejectUnauthorized = true, contextKey, preferredPreviousResponseId, proxyKey) {
    const key = connectionPoolKey(copilotToken, proxyKey);

    // Copilot 特定的连接工厂
    const connectFn = async () => {
        const baseUrl = getCopilotBaseUrl(accountType);
        const wsUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/responses';
        const headers = wsHeaders(copilotToken, vsCodeVersion);
        logger.info(`WS pool: creating new connection to ${wsUrl}`);
        return connectWebSocket(wsUrl, headers, agent, undefined, rejectUnauthorized);
    };

    return copilotPool.acquire(key, connectFn, {
        contextKey,
        preferredPreviousResponseId
    });
}

export function release(conn) {
    copilotPool.release(conn);
}

export function discard(conn) {
    copilotPool.discard(conn);
}

export function shutdown() {
    copilotPool.shutdown();
}

export {sendRequest} from './copilot-ws-client.js';
