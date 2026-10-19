/**
 * Copilot WebSocket 客户端 - Re-export wrapper
 * 向后兼容，所有逻辑已移至共享模块 @see ../ws/ws-client.js
 * @module services/copilot/copilot-ws-client
 */

import {ResponsesWSError, connectWebSocket, sendRequest, prepareWebSocketPayload} from '../ws/ws-client.js';

/**
 * Copilot 专用的 Responses WS 错误类（保持向后兼容）
 * @see ResponsesWSError
 */
class CopilotResponsesWSError extends ResponsesWSError {
    constructor(event) {
        super(event);
        this.name = 'CopilotResponsesWSError';
    }
}

export {
    CopilotResponsesWSError,
    connectWebSocket,
    sendRequest,
    prepareWebSocketPayload
};
