/**
 * 通用 Responses API WebSocket 服务端处理器
 * 处理客户端 WS 连接，实现标准 Responses API WS 协议
 * 协议规范：客户端发送 response.create，服务端返回事件流
 * @module services/ws/ws-server
 */

import logger from '../../utils/logger.js';

/**
 * 处理客户端 WS 连接，实现标准 Responses API WS 协议
 *
 * 协议流程：
 * 1. 客户端发送 {"type": "response.create", ...payload}
 * 2. 服务端调用 handleRequest 获取事件流
 * 3. 服务端逐个将事件通过 WS 发送给客户端
 * 4. 发送 response.completed 或 error 后，请求结束
 * 5. 连接保持，客户端可发送新的 response.create
 * 6. 客户端可发送 {"type": "response.cancel"} 取消当前请求
 *
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {object} options
 * @param {function} options.authenticate - 鉴权函数 (req) => boolean | object，返回 false 表示拒绝
 * @param {function} options.handleRequest - 请求处理函数
 *   签名: async (payload, authResult) => AsyncIterable<{type, data}> | {eventStream: AsyncIterable, conn?: object}
 * @param {http.IncomingMessage} options.req - 原始 HTTP 请求（用于鉴权）
 * @param {function} [options.onUsage] - 用量记录回调 (inputTokens, outputTokens, cacheHitTokens, model) => void
 * @param {function} [options.onClose] - 连接关闭回调
 */
export function handleWSConnection(clientWs, options) {
    const {authenticate, handleRequest, req, onUsage, onClose} = options;

    let currentAbortController = null;
    let isProcessing = false;
    let closed = false;

    // 鉴权
    const authResult = authenticate(req);
    if (!authResult) {
        clientWs.send(JSON.stringify({
            type: 'error',
            error: {message: 'Authentication failed', code: 'unauthorized'}
        }));
        setTimeout(() => {
            try { clientWs.close(4001, 'Authentication failed'); } catch {}
        }, 100);
        return;
    }

    clientWs.on('message', async (raw) => {
        if (closed) return;

        let message;
        try {
            message = JSON.parse(raw.toString('utf8'));
        } catch (e) {
            logger.warn('WS server: Failed to parse client message:', e.message);
            clientWs.send(JSON.stringify({
                type: 'error',
                error: {message: 'Invalid JSON message', code: 'invalid_request'}
            }));
            return;
        }

        if (message.type === 'response.create') {
            if (isProcessing) {
                clientWs.send(JSON.stringify({
                    type: 'error',
                    error: {message: 'A response is already being processed', code: 'conflict'}
                }));
                return;
            }
            await _processRequest(clientWs, message, authResult, handleRequest, {
                onUsage,
                getAbortController: () => currentAbortController,
                setAbortController: (ac) => { currentAbortController = ac; },
                setProcessing: (v) => { isProcessing = v; },
                isClosed: () => closed,
            });
        } else if (message.type === 'response.cancel') {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
        } else {
            logger.warn(`WS server: Unknown message type: ${message.type}`);
        }
    });

    clientWs.on('close', () => {
        closed = true;
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        if (onClose) onClose();
    });

    clientWs.on('error', (err) => {
        logger.warn(`WS server: Client connection error: ${err.message}`);
        closed = true;
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
    });
}

/**
 * 处理单个 response.create 请求
 */
async function _processRequest(clientWs, message, authResult, handleRequest, ctx) {
    ctx.setProcessing(true);
    const abortController = new AbortController();
    ctx.setAbortController(abortController);

    // 提取 payload：标准格式为 {type: "response.create", response: {...}, ...}
    // 兼容直接发送 payload 的格式
    let payload = message.response || message;
    if (message.response && typeof message.response === 'object') {
        // 标准格式：合并顶层字段（除 type 和 response）
        const {type, response, ...rest} = message;
        payload = {...rest, ...response};
    }

    let conn = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheHitTokens = 0;
    let model = 'unknown';

    try {
        const result = await handleRequest(payload, authResult, {signal: abortController.signal});

        // handleRequest 可以返回：
        // 1. AsyncIterable<{type, data}> - 直接迭代事件
        // 2. {eventStream: AsyncIterable, conn?: object} - 带连接对象的事件流
        let eventStream;
        if (result && result.eventStream) {
            eventStream = result.eventStream;
            conn = result.conn || null;
        } else {
            eventStream = result;
        }

        if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== 'function') {
            clientWs.send(JSON.stringify({
                type: 'error',
                error: {message: 'Internal error: invalid event stream', code: 'server_error'}
            }));
            return;
        }

        for await (const event of eventStream) {
            if (ctx.isClosed() || abortController.signal.aborted) break;

            // 追踪 usage
            if (event.type === 'response.completed' && event.data?.response?.usage) {
                const usage = event.data.response.usage;
                inputTokens = usage.input_tokens || 0;
                outputTokens = usage.output_tokens || 0;
                cacheHitTokens = usage.input_tokens_details?.cached_tokens || 0;
            }
            if (event.type === 'response.created' && event.data?.response?.model) {
                model = event.data.response.model;
            }

            // 发送事件给客户端
            clientWs.send(JSON.stringify(event.data || event));

            if (event.type === 'response.completed') break;
        }
    } catch (err) {
        if (!ctx.isClosed()) {
            const errorEvent = {
                type: 'error',
                error: {
                    message: err.message || 'Request failed',
                    code: err.code || 'server_error'
                }
            };

            // 如果是 ResponsesWSError，透传上游错误
            if (err.name === 'ResponsesWSError' && err.event) {
                clientWs.send(JSON.stringify(err.event));
            } else {
                clientWs.send(JSON.stringify(errorEvent));
            }
        }
    } finally {
        // 注意：WS 上游连接的释放由各服务的 handleRequest 生成器自行处理
        // （在 for-await 循环结束后调用 releaseWSConnection/discardWSConnection）

        // 记录用量
        if (ctx.onUsage && (inputTokens > 0 || outputTokens > 0)) {
            ctx.onUsage(inputTokens, outputTokens, cacheHitTokens, model);
        }

        ctx.setProcessing(false);
        ctx.setAbortController(null);
    }
}
