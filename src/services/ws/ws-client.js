/**
 * 通用 Responses API WebSocket 客户端
 * 处理与上游 Responses WS 端点的连接和请求/响应流
 * 从 copilot-ws-client.js 提取，去除 Copilot 特定逻辑
 * @module services/ws/ws-client
 */

import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import {sanitizeResponsesInput} from '../../transformer/responses-translator.js';

const CONNECT_TIMEOUT = 30000;
const PING_INTERVAL = 30000; // 30 秒心跳，防止中间设备因空闲而断开 TCP 连接

/**
 * Responses WebSocket 协议错误
 */
export class ResponsesWSError extends Error {
    constructor(event) {
        const errorInfo = event?.error || {};
        super(errorInfo.message || 'Responses WebSocket request failed');
        this.name = 'ResponsesWSError';
        this.event = event;
        this.status = event?.status;
        this.code = errorInfo.code;
        this.param = errorInfo.param;
        this.type = errorInfo.type;
    }
}

/**
 * 准备 WebSocket 发送的 payload，去除 WS 协议不支持的字段
 */
export function prepareWebSocketPayload(payload) {
    const {
        stream,
        background,
        include,
        metadata,
        store,
        text,
        truncation,
        user,
        ...rest
    } = payload || {};
    return rest;
}

/**
 * 建立 WebSocket 连接
 * @param {string} url - WS 端点 URL
 * @param {object} headers - 连接头
 * @param {import('https-proxy-agent').HttpsProxyAgent|import('socks-proxy-agent').SocksProxyAgent} [agent] - 代理 agent
 * @param {number} [timeout=30000] - 连接超时
 * @param {boolean} [rejectUnauthorized=true] - 是否验证 TLS
 * @returns {Promise<WebSocket>}
 */
export function connectWebSocket(url, headers, agent, timeout = CONNECT_TIMEOUT, rejectUnauthorized = true) {
    return new Promise((resolve, reject) => {
        let ws;
        let pingTimer = null;

        const clearPingTimer = () => {
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
        };

        const timer = setTimeout(() => {
            clearPingTimer();
            try { ws?.close(); } catch {}
            reject(new Error(`WebSocket connect timeout after ${timeout}ms`));
        }, timeout);

        const wsOptions = {headers, handshakeTimeout: timeout, rejectUnauthorized};
        if (agent) wsOptions.agent = agent;

        ws = new WebSocket(url, wsOptions);

        ws.on('open', () => {
            clearTimeout(timer);
            // 启动心跳：定期发送 ping，防止 NAT/防火墙/LB 因空闲断开 TCP 连接
            pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try { ws.ping(); } catch {}
                }
            }, PING_INTERVAL);
            resolve(ws);
        });

        ws.on('close', () => {
            clearPingTimer();
        });

        ws.on('error', (err) => {
            clearPingTimer();
            clearTimeout(timer);
            reject(err);
        });

        ws.on('unexpected-response', (req, res) => {
            clearPingTimer();
            clearTimeout(timer);
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => reject(new Error(`WebSocket upgrade failed: ${res.statusCode} ${body.slice(0, 200)}`)));
        });
    });
}

/**
 * 通过 WebSocket 发送 Responses 请求并异步迭代返回事件
 * @param {WebSocket|object} wsOrConn - WebSocket 实例或 PooledConnection（含 .ws 属性）
 * @param {object} payload - Responses API 请求体
 * @yields {{type: string, data: object}} WS 事件
 */
export async function* sendRequest(wsOrConn, payload) {
    const ws = wsOrConn?.ws || wsOrConn;
    const conn = wsOrConn?.ws ? wsOrConn : null;
    let resolveMessage;
    let rejectMessage;
    let messageQueue = [];
    let streamDone = false;
    let streamError = null;

    if (Array.isArray(payload.input)) {
        const beforeTypes = payload.input.map(i => i?.type || i?.role || 'unknown');
        payload = {...payload, input: sanitizeResponsesInput(payload.input)};
        const afterTypes = payload.input.map(i => i?.type || i?.role || 'unknown');
        if (beforeTypes.join(',') !== afterTypes.join(',')) {
            logger.info(`WS: sanitized input types [${beforeTypes}] → [${afterTypes}]`);
        }
    }

    const explicitPreviousResponseId = typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
        ? payload.previous_response_id.trim()
        : null;
    const autoPreviousResponseId = !explicitPreviousResponseId && conn?.contextKey && conn.lastResponseId
        ? conn.lastResponseId
        : null;
    const referencedPreviousResponseId = explicitPreviousResponseId || autoPreviousResponseId;

    if (explicitPreviousResponseId) {
        payload = {...payload, previous_response_id: explicitPreviousResponseId};
    } else if (autoPreviousResponseId) {
        logger.info(`WS: auto-linking context with previous_response_id=${autoPreviousResponseId}`);
        payload = {...payload, previous_response_id: autoPreviousResponseId};
    }

    const onMessage = (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw.toString('utf8'));
        } catch (e) {
            logger.warn('WS: Failed to parse message:', e.message);
            return;
        }

        if (conn && parsed.type === 'response.created' && parsed.response?.id) {
            conn.lastResponseId = parsed.response.id;
        }

        if (parsed.type === 'error') {
            if (conn && referencedPreviousResponseId && conn.lastResponseId === referencedPreviousResponseId) {
                conn.lastResponseId = null;
            }
            streamDone = true;
            streamError = new ResponsesWSError(parsed);
            if (parsed.error?.code === 'websocket_connection_limit_reached') {
                try { ws.close(); } catch {}
            }
            if (resolveMessage) {
                const r = resolveMessage;
                resolveMessage = null;
                rejectMessage = null;
                r();
            }
            return;
        }

        messageQueue.push(parsed);
        if (resolveMessage) {
            const r = resolveMessage;
            resolveMessage = null;
            rejectMessage = null;
            r();
        }
    };

    const onError = (err) => {
        streamError = err;
        if (rejectMessage) {
            const r = rejectMessage;
            resolveMessage = null;
            rejectMessage = null;
            r(err);
        }
    };

    const onClose = () => {
        streamDone = true;
        if (resolveMessage) {
            const r = resolveMessage;
            resolveMessage = null;
            rejectMessage = null;
            r();
        }
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);

    ws.send(JSON.stringify({type: 'response.create', ...prepareWebSocketPayload(payload)}));

    try {
        while (!streamDone || messageQueue.length > 0) {
            if (streamError && messageQueue.length === 0) throw streamError;
            if (messageQueue.length > 0) {
                const msg = messageQueue.shift();
                yield {type: msg.type, data: msg};
                if (msg.type === 'response.completed') break;
                continue;
            }
            if (streamDone) break;
            await new Promise((resolve, reject) => {
                resolveMessage = resolve;
                rejectMessage = reject;
            });
            if (streamError) throw streamError;
        }
        if (streamError) throw streamError;
    } finally {
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
    }
}
