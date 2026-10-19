/**
 * Relay 路由处理器 - 支持 OpenAI、Anthropic、Responses 三种协议
 * 对活跃上游发起请求，根据上游协议自动选择最优路径（透传 > 转换）
 * 支持 Responses API WebSocket 模式（上游 WS 连接 + 对外 WS 端点）
 * @module routes/relay
 */

import {relayStore} from '../services/relay/relay-store.js';
import {
    createChatCompletions,
    createResponses,
    createAnthropicMessages,
    createAnthropicCountTokens,
    getUpstreamModels,
    isAnthropicUpstream,
    isResponsesUpstream,
    normalizeUpstreamProtocol,
    createResponsesWS,
    releaseWSConnection,
    discardWSConnection,
    isWSUpstream,
    ResponsesWSError,
    RelayUpstreamError
} from '../services/relay/api.js';
import {readBody, isNetworkError} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic,
    ClaudeStreamState,
    SSEWriter,
    injectBehaviorRules,
    mapStopReason
} from '../services/relay/translator.js';
import {
    rewriteOpenAIStream,
    stripDynamicReminders,
    buildConversationAnchorKey,
    normalizeConversationKey,
    extractConversationKeyFromPayload,
    extractConversationKey
} from '../transformer/shared-translator.js';
import {
    responsesRequestToChat,
    chatRequestToResponses,
    chatResponseToResponses,
    responsesResponseToChat,
    createResponsesStreamState,
    createChatCompletionsStreamState,
    chatChunkToResponsesEvents,
    responsesEventToChatChunks,
    compactRequestToChat,
    chatResponseToCompact
} from '../transformer/responses-translator.js';
import {aggregateStreamResponse} from '../services/codebuddy/api.js';
import {estimateMessageTokens} from '../utils/token-estimation.js';
import {handleWSConnection} from '../services/ws/ws-server.js';
import {
    anthropicToResponses,
    responsesEventToAnthropicEvents,
    responsesOutputToAnthropic,
    createStreamState as createAnthropicStreamState
} from '../services/copilot/anthropic-translator.js';
import logger from '../utils/logger.js';

/* ==================== 工具函数 ==================== */

/* ==================== 会话 Key 推算 ==================== */

/**
 * 全局用户名，用于拼接 X-Session-ID 头让上游做实例亲和性路由
 * 当前项目是单用户场景（默认 admin），所有请求走同一推理实例最大化 KV Cache 复用
 * 后续多用户场景需要改造为从 req 提取动态 username
 */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

// 会话键推算函数已上提到 shared-translator.js（供 relay / copilot / codebuddy 三后端共用），
// 此处 re-export 保持既有调用方与测试的 import 路径不变
export {normalizeConversationKey, extractConversationKeyFromPayload, extractConversationKey};

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendOpenAIError(res, status, message, type = 'api_error') {
    sendJson(res, status, {error: {message, type, code: status}});
}

function sendAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendJson(res, status, {type: 'error', error: {type: errorType, message}});
}

function upstreamErrorStatus(err) {
    if (err instanceof RelayUpstreamError) {
        // 429 保持原样返回，其余 >= 400 的上游错误映射为 502
        if (err.status === 429) return 429;
        return 502;
    }
    return isNetworkError(err) ? 502 : 500;
}

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function readResponseBody(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

function extractAnthropicCacheHitTokens(usage) {
    if (!usage) return 0;
    return usage.cache_read_input_tokens || extractCacheHitTokens(usage);
}

function parseSSEBlock(block) {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }

    return {event, data: dataLines.join('\n')};
}

function handleAnthropicUsageEvent(eventName, payload, usageState) {
    const usage = payload?.usage || payload?.message?.usage;
    if (!usage) return;

    if (usage.input_tokens !== undefined) usageState.inputTokens = usage.input_tokens;
    if (usage.output_tokens !== undefined) usageState.outputTokens = usage.output_tokens;
    usageState.cacheHitTokens = Math.max(usageState.cacheHitTokens, extractAnthropicCacheHitTokens(usage));
    if (eventName === 'message_start' && payload?.message?.model) usageState.model = payload.message.model;
}

function estimateAnthropicInputTokens(payload) {
    const messages = [];
    if (typeof payload.system === 'string') {
        messages.push({role: 'system', content: payload.system});
    } else if (Array.isArray(payload.system)) {
        messages.push({role: 'system', content: payload.system});
    }
    messages.push(...(payload.messages || []));
    const messageTokens = estimateMessageTokens(messages);
    const toolTokens = Array.isArray(payload.tools)
        ? estimateMessageTokens(payload.tools.map((tool) => ({role: 'tool', content: JSON.stringify(tool)})))
        : 0;
    return messageTokens + toolTokens;
}

function mapAnthropicModelsToOpenAI(modelsData) {
    const items = Array.isArray(modelsData?.data) ? modelsData.data : [];
    return {
        object: 'list',
        data: items.map((model) => ({
            id: model.id,
            object: 'model',
            created: model.created_at ? Math.floor(new Date(model.created_at).getTime() / 1000) : 0,
            owned_by: model.display_name || model.type || 'anthropic'
        }))
    };
}

function mapOpenAIModelsToAnthropic(modelsData) {
    return {
        data: (modelsData.data || []).map((model) => ({
            id: model.id,
            object: 'model',
            created: model.created || 0,
            owned_by: model.owned_by || model.owner || 'relay',
            name: model.id,
            capabilities: {}
        })),
        object: 'list'
    };
}

function getAnthropicRequestHeaders(req) {
    return {
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        ...(req.headers['anthropic-beta'] ? {'anthropic-beta': req.headers['anthropic-beta']} : {})
    };
}

function getProtocolErrorMessage(upstream, expectedProtocol, endpoint) {
    const protocol = normalizeUpstreamProtocol(upstream?.protocol);
    if (protocol === expectedProtocol) return null;
    if (expectedProtocol === 'anthropic') {
        return `当前上游协议为 ${protocol}，请改用 ${endpoint} 或切换上游类型`;
    }
    return `当前上游协议为 ${protocol}，该端点需要 ${expectedProtocol} 上游支持`;
}

/* ==================== 鉴权 ==================== */

/**
 * 获取上游配置，若无可用上游则返回错误
 * 网关层已统一完成客户端 API Key 鉴权
 */
function getUpstreamOrFail() {
    const upstreamManager = relayStore.getUpstreamManager();
    if (!upstreamManager) {
        return {error: {status: 503, message: 'Relay upstream manager not found'}};
    }

    const upstream = upstreamManager.getActiveUpstream();
    if (!upstream) {
        return {error: {status: 503, message: '未配置可用上游，请在管理面板 /relayFE 配置'}};
    }

    return {upstream, upstreamManager};
}

/**
 * 调用上游，失败直接抛错
 * 上游返回 429 时顺带标记该上游进入冷却（仅内部记账，不改对外响应语义）
 * 注：create* 系列在非 2xx 时内部已抛出 RelayUpstreamError，因此在 catch 中识别 429
 */
async function callUpstream(upstream, fn) {
    let response;
    try {
        response = await fn(upstream);
    } catch (err) {
        if (err instanceof RelayUpstreamError && err.status === 429) {
            const manager = relayStore.getUpstreamManager();
            if (manager && upstream && typeof upstream.index === 'number') {
                manager.markRateLimited(upstream.index);
                logger.warn(`Relay: 上游「${upstream.name}」返回 429，已标记冷却`);
            }
        }
        throw err;
    }
    if (response.status >= 200 && response.status < 300) {
        return {response, upstream};
    }
    if (response.status === 429 && upstream && typeof upstream.index === 'number') {
        const manager = relayStore.getUpstreamManager();
        if (manager) {
            manager.markRateLimited(upstream.index);
            logger.warn(`Relay: 上游「${upstream.name}」返回 429，已标记冷却`);
        }
    }
    const errorBody = await readBody(response.body);
    throw new RelayUpstreamError(response.status, `上游「${upstream.name}」返回 HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
}

function recordUsage(inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown') {
    relayStore.incrementApiCallCount();
    relayStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
    relayStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
}

/* ==================== 处理函数 ==================== */

/**
 * 处理 OpenAI 格式的 /relay/v1/chat/completions 请求
 * 根据上游协议自动选择最优路径：
 * - Anthropic 上游 → 报错引导
 * - Responses 上游 → Chat→Responses 转换
 * - OpenAI 上游 → 直接透传
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const {upstream, upstreamManager} = authResult;
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        if (isAnthropicUpstream(upstream)) {
            sendOpenAIError(res, 400, getProtocolErrorMessage(upstream, 'openai', '/relay/anthropic/v1/messages'));
            return;
        }

        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
        // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
        openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);

        if (isResponsesUpstream(upstream)) {
            const responsesPayload = chatRequestToResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index)
            });

            const conversationKey = extractConversationKey(req, responsesPayload);
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};

            const {response} = await callUpstream(upstream, (up) =>
                createResponses(responsesPayload, up, {
                    requestType: 'ChatCompletionsViaResponses',
                    stream: openAIPayload.stream,
                    originalModel: openAIPayload.model,
                    ...relayMeta
                })
            );

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const streamState = createChatCompletionsStreamState();
                let buffer = '';
                let usage = null;

                response.body.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (!data || data === '[DONE]') continue;
                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        } catch {
                            continue;
                        }

                        if (event === 'response.created' && parsed.response?.model) {
                            streamState.model = parsed.response.model;
                        }

                        if (event === 'response.completed') {
                            usage = parsed.response?.usage || usage;
                        }

                        const chunks = responsesEventToChatChunks(event, parsed, streamState);
                        for (const chatChunk of chunks) {
                            res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                        }

                        if (event === 'response.completed') {
                            recordUsage(
                                usage?.input_tokens || 0,
                                usage?.output_tokens || 0,
                                usage?.input_tokens_details?.cached_tokens || 0,
                                openAIPayload.model
                            );
                            res.write('data: [DONE]\n\n');
                        }
                    }
                });

                response.body.on('end', () => {
                    if (!streamState.completed) {
                        res.write(`data: ${JSON.stringify({
                            id: streamState.chatId,
                            object: 'chat.completion.chunk',
                            created: streamState.created,
                            model: streamState.model,
                            choices: [{index: 0, delta: {}, finish_reason: streamState.sawToolCall ? 'tool_calls' : 'stop'}]
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                    }
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Relay Responses->Chat stream error:', err);
                    res.end();
                });
                return;
            }

            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                logger.error('Relay: failed to parse responses upstream non-stream response');
                sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                return;
            }

            recordUsage(
                parsed.usage?.input_tokens || 0,
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                openAIPayload.model
            );
            sendJson(res, 200, responsesResponseToChat(parsed));
            return;
        }

        // 标准 OpenAI Chat Completions 透传
        if (openAIPayload.stream) {
            openAIPayload.stream_options = {include_usage: true};
        }
        const conversationKey = extractConversationKey(req, openAIPayload);
        const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
        const {response} = await callUpstream(upstream, (up) => {
            const payload = {...openAIPayload, model: upstreamManager.resolveModel(openAIPayload.model, up.index)};
            return createChatCompletions(payload, up, relayMeta);
        });

        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            _streamOpenAIPassthrough(response, res, openAIPayload.model);
        } else {
            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                logger.error('Relay: failed to parse upstream non-stream response');
                sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                return;
            }
            const cacheHitTokens = extractCacheHitTokens(parsed.usage);
            recordUsage(
                parsed.usage?.prompt_tokens || 0,
                parsed.usage?.completion_tokens || 0,
                cacheHitTokens,
                openAIPayload.model
            );
            sendJson(res, 200, parsed);
        }
    } catch (error) {
        logger.error('Relay: Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /relay/anthropic/v1/messages 请求
 * 根据上游协议自动选择最优路径：
 * - Responses 上游 → Anthropic↔Responses 转换（支持 WS 模式）
 * - Anthropic 上游 → 直接透传（零损耗）
 * - OpenAI 上游 → Anthropic→OpenAI 转换
 */
async function handleAnthropicMessages(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, upstreamManager} = authResult;
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        if (isResponsesUpstream(upstream)) {
            // anthropic 转 responses 前先剥离动态 reminder
            anthropicPayload.messages = stripDynamicReminders(anthropicPayload.messages);
            const responsesReq = anthropicToResponses(anthropicPayload);
            responsesReq.model = upstreamManager.resolveModel(anthropicPayload.model, upstream.index);
            const conversationKey = extractConversationKey(req, responsesReq);

            // WS 模式：通过 WebSocket 连接上游
            if (isWSUpstream(upstream)) {
                try {
                    const wsResult = await createResponsesWS(
                        responsesReq,
                        upstream,
                        {contextKey: conversationKey}
                    );

                    if (anthropicPayload.stream) {
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            Connection: 'keep-alive'
                        });

                        const chatState = createChatCompletionsStreamState();
                        const anthropicState = createAnthropicStreamState();
                        let inputTokens = 0;
                        let outputTokens = 0;
                        let cacheHitTokens = 0;

                        try {
                            for await (const event of wsResult.eventStream) {
                                if (event.type === 'response.completed' && event.data?.response?.usage) {
                                    const usage = event.data.response.usage;
                                    inputTokens = usage.input_tokens || 0;
                                    outputTokens = usage.output_tokens || 0;
                                    cacheHitTokens = usage.input_tokens_details?.cached_tokens || 0;
                                }
                                const anthropicEvents = responsesEventToAnthropicEvents(
                                    event.type, event.data, chatState, anthropicState
                                );
                                for (const evt of anthropicEvents) {
                                    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
                                }
                            }
                            releaseWSConnection(wsResult.conn);
                        } catch (err) {
                            discardWSConnection(wsResult.conn);
                            throw err;
                        }

                        recordUsage(
                            inputTokens || estimateAnthropicInputTokens(anthropicPayload),
                            outputTokens,
                            cacheHitTokens,
                            anthropicPayload.model
                        );
                        res.end();
                    } else {
                        let completedData = null;
                        try {
                            for await (const event of wsResult.eventStream) {
                                if (event.type === 'response.completed') completedData = event.data;
                            }
                            releaseWSConnection(wsResult.conn);
                        } catch (err) {
                            discardWSConnection(wsResult.conn);
                            throw err;
                        }
                        if (completedData?.response) {
                            const usage = completedData.response.usage || {};
                            recordUsage(
                                usage.input_tokens || estimateAnthropicInputTokens(anthropicPayload),
                                usage.output_tokens || 0,
                                usage.input_tokens_details?.cached_tokens || 0,
                                anthropicPayload.model
                            );
                            sendJson(res, 200, responsesOutputToAnthropic(completedData.response));
                        } else {
                            sendAnthropicError(res, 502, 'No response.completed event received from upstream');
                        }
                    }
                    return;
                } catch (wsError) {
                    if (wsError instanceof ResponsesWSError) {
                        if (res.headersSent) {
                            if (!res.destroyed && !res.writableEnded) res.end();
                            return;
                        }
                        sendAnthropicError(res, wsError.status || 400, wsError.message || 'WS upstream error');
                        return;
                    }
                    if (res.headersSent) {
                        logger.warn(`Relay Anthropic: WS stream failed after response started: ${wsError.message}`);
                        if (!res.destroyed && !res.writableEnded) res.end();
                        return;
                    }
                    logger.warn(`Relay Anthropic: WS failed, falling back to HTTP: ${wsError.message}`);
                    // Fall through to HTTP logic below
                }
            }

            // HTTP 模式：请求上游 Responses API，转换响应
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(responsesReq, up, {
                    requestType: 'AnthropicViaResponses',
                    stream: anthropicPayload.stream,
                    originalModel: anthropicPayload.model,
                    ...relayMeta
                })
            );

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatState = createChatCompletionsStreamState();
                const anthropicState = createAnthropicStreamState();
                let inputTokens = 0;
                let outputTokens = 0;
                let cacheHitTokens = 0;
                let buffer = '';

                response.body.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (!data || data === '[DONE]') continue;
                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        } catch {
                            continue;
                        }

                        if (event === 'response.completed' && parsed.response?.usage) {
                            const usage = parsed.response.usage;
                            inputTokens = usage.input_tokens || 0;
                            outputTokens = usage.output_tokens || 0;
                            cacheHitTokens = usage.input_tokens_details?.cached_tokens || 0;
                        }

                        const anthropicEvents = responsesEventToAnthropicEvents(event, parsed, chatState, anthropicState);
                        for (const evt of anthropicEvents) {
                            res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
                        }
                    }
                });

                response.body.on('end', () => {
                    recordUsage(
                        inputTokens || estimateAnthropicInputTokens(anthropicPayload),
                        outputTokens,
                        cacheHitTokens,
                        anthropicPayload.model
                    );
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Relay Anthropic via Responses stream error:', err);
                    res.end();
                });
                return;
            }

            // 非流式 HTTP
            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                sendAnthropicError(res, 502, 'Upstream returned invalid JSON');
                return;
            }
            recordUsage(
                parsed.usage?.input_tokens || estimateAnthropicInputTokens(anthropicPayload),
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                anthropicPayload.model
            );
            sendJson(res, 200, responsesOutputToAnthropic(parsed));
            return;
        }

        // Anthropic 上游透传（零损耗）
        if (isAnthropicUpstream(upstream)) {
            const conversationKey = extractConversationKey(req, anthropicPayload);
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
            const {response} = await callUpstream(upstream, (up) =>
                createAnthropicMessages(
                    {...anthropicPayload, model: upstreamManager.resolveModel(anthropicPayload.model, up.index)},
                    up,
                    {
                        requestType: 'AnthropicPassthrough',
                        stream: anthropicPayload.stream,
                        originalModel: anthropicPayload.model,
                        ...relayMeta
                    },
                    getAnthropicRequestHeaders(req)
                )
            );

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const usageState = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheHitTokens: 0,
                    model: anthropicPayload.model
                };
                let buffer = '';

                response.body.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    res.write(text);
                    buffer += text;
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (!data || data === '[DONE]') continue;
                        try {
                            handleAnthropicUsageEvent(event, JSON.parse(data), usageState);
                        } catch {
                            continue;
                        }
                    }
                });

                response.body.on('end', () => {
                    if (buffer.trim()) {
                        const {event, data} = parseSSEBlock(buffer);
                        if (data && data !== '[DONE]') {
                            try {
                                handleAnthropicUsageEvent(event, JSON.parse(data), usageState);
                            } catch {
                            }
                        }
                    }
                    const inputTokens = usageState.inputTokens || estimateAnthropicInputTokens(anthropicPayload);
                    recordUsage(
                        inputTokens,
                        usageState.outputTokens,
                        usageState.cacheHitTokens,
                        usageState.model || anthropicPayload.model
                    );
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Relay Anthropic passthrough stream error:', err);
                    res.end();
                });
                return;
            }

            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                sendAnthropicError(res, 502, 'Upstream returned invalid JSON');
                return;
            }

            recordUsage(
                parsed.usage?.input_tokens || estimateAnthropicInputTokens(anthropicPayload),
                parsed.usage?.output_tokens || 0,
                extractAnthropicCacheHitTokens(parsed.usage),
                parsed.model || anthropicPayload.model
            );
            sendJson(res, 200, parsed);
            return;
        }

        // OpenAI 上游：Anthropic → OpenAI 转换
        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        if (anthropicPayload.stream) {
            openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
            // 剥离纯记账性质的 system-reminder 块
            openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);
            openAIPayload.stream_options = {include_usage: true};
            const conversationKey = extractConversationKey(req, openAIPayload);
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
            const {response} = await callUpstream(upstream, (up) => {
                const payload = {
                    ...openAIPayload,
                    model: upstreamManager.resolveModel(openAIPayload.model, up.index)
                };
                return createChatCompletions(payload, up, {
                    requestType: 'Anthropic',
                    stream: anthropicPayload.stream,
                    originalModel: anthropicPayload.model,
                    ...relayMeta
                });
            });

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const writer = new SSEWriter(res);
            const state = new ClaudeStreamState(writer);
            let buffer = Buffer.alloc(0);
            let partialTextBuffer = '';
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;

            response.body.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;
                    let data;
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }

                    const choice = data.choices?.[0];
                    const delta = choice?.delta;

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                    }

                    state.startMessage(data.model);

                    let reasoningText = null;
                    let signature = null;
                    if (delta?.reasoning_content) {
                        reasoningText = delta.reasoning_content;
                    } else if (typeof delta?.thinking === 'string') {
                        reasoningText = delta.thinking;
                    } else if (typeof delta?.thinking === 'object' && delta.thinking !== null) {
                        reasoningText = delta.thinking.content || null;
                        signature = delta.thinking.signature || null;
                    } else if (delta?.thought) {
                        reasoningText = typeof delta.thought === 'string' ? delta.thought : null;
                    } else if (delta?.reasoning) {
                        reasoningText = typeof delta.reasoning === 'string' ? delta.reasoning : null;
                    }
                    if (!signature) {
                        signature =
                            delta?.reasoning_signature ||
                            (choice?.finish_reason === 'thinking' ? Date.now().toString() : null);
                    }
                    if (reasoningText) state.appendThinking(reasoningText);
                    if (signature) state.closeThinking(signature);

                    if (Array.isArray(delta?.tool_calls)) {
                        for (const tool of delta.tool_calls) {
                            const idx = tool.index;
                            if (tool.function?.name) state.startTool(idx, tool.function.name, tool.id);
                            if (tool.function?.arguments) state.appendToolArgs(idx, tool.function.arguments);
                        }
                    }
                    if (delta?.content && !reasoningText) partialTextBuffer += delta.content;
                    if (choice?.finish_reason) {
                        if (partialTextBuffer) {
                            state.appendText(partialTextBuffer);
                            partialTextBuffer = '';
                        }
                        state.finalStopReason = mapStopReason(choice.finish_reason);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                if (partialTextBuffer) {
                    state.appendText(partialTextBuffer);
                    partialTextBuffer = '';
                }
                state.endMessage(state.finalStopReason, streamCacheHitTokens);
                recordUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, anthropicPayload.model);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Relay Anthropic stream error:', err);
                state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));
                state.finalStopReason = 'error';
                state.endMessage('error');
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，用 aggregateStreamResponse 聚合
            openAIPayload.stream = true;
            openAIPayload.stream_options = {include_usage: true};
            openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
            // 剥离纯记账性质的 system-reminder 块
            openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);
            const conversationKey = extractConversationKey(req, openAIPayload);
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
            const {response} = await callUpstream(upstream, (up) => {
                const payload = {
                    ...openAIPayload,
                    model: upstreamManager.resolveModel(openAIPayload.model, up.index)
                };
                return createChatCompletions(payload, up, {
                    requestType: 'Anthropic',
                    stream: false,
                    originalModel: anthropicPayload.model,
                    ...relayMeta
                });
            });

            const aggregated = await aggregateStreamResponse(response.body);
            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            recordUsage(inputTokens, outputTokens, cacheHitTokens, anthropicPayload.model);

            const openAIResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || openAIPayload.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: aggregated.content || null,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop'
                    }
                ],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };
            sendJson(res, 200, openAIToAnthropic(openAIResponse));
        }
    } catch (error) {
        logger.error('Relay: Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== 流式响应辅助 ==================== */

/** OpenAI 上游流式透传（OpenAI 端点 → OpenAI 上游），对 reasoning_content 做缓冲合并 */
function _streamOpenAIPassthrough(response, res, model = 'unknown') {
    rewriteOpenAIStream(res, response.body, (inputTokens, outputTokens, cacheHitTokens) => {
        recordUsage(inputTokens, outputTokens, cacheHitTokens, model);
    });
}

/* ==================== 其他端点 ==================== */

async function handleOpenAIModels(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const modelsData = await getUpstreamModels(authResult.upstream, getAnthropicRequestHeaders(req));
        sendJson(res, 200, isAnthropicUpstream(authResult.upstream) ? mapAnthropicModelsToOpenAI(modelsData) : modelsData);
    } catch (error) {
        logger.error('Relay: Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

async function handleAnthropicModels(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const modelsData = await getUpstreamModels(authResult.upstream, getAnthropicRequestHeaders(req));
        sendJson(res, 200, isAnthropicUpstream(authResult.upstream) ? modelsData : mapOpenAIModelsToAnthropic(modelsData));
    } catch (error) {
        logger.error('Relay: Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

async function handleAnthropicCountTokens(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        if (isAnthropicUpstream(authResult.upstream)) {
            const {response} = await callUpstream(authResult.upstream, (up) =>
                createAnthropicCountTokens(anthropicPayload, up, getAnthropicRequestHeaders(req))
            );
            const responseBody = await readResponseBody(response.body);
            sendJson(res, 200, JSON.parse(responseBody));
            return;
        }

        if (isResponsesUpstream(authResult.upstream)) {
            sendAnthropicError(res, 400, getProtocolErrorMessage(authResult.upstream, 'anthropic', '/relay/v1/responses'));
            return;
        }

        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4);
        sendJson(res, 200, {input_tokens: estimatedTokens});
    } catch (error) {
        logger.error('Relay: Failed to count tokens:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses API ==================== */

/**
 * 处理 Responses API 请求 (/relay/v1/responses)
 * 根据上游协议自动选择最优路径：
 * - Anthropic 上游 → 报错引导
 * - Responses 上游 + WS → WS 优先，HTTP 回退
 * - Responses 上游 → 直接透传
 * - OpenAI 上游 → Responses→Chat 转换 → Chat→Responses 转回
 */
async function handleResponsesAPI(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, upstreamManager} = authResult;
        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        if (isAnthropicUpstream(upstream)) {
            sendOpenAIError(res, 400, getProtocolErrorMessage(upstream, 'responses', '/relay/anthropic/v1/messages'));
            return;
        }

        // Responses 上游：WS 优先，HTTP 回退
        if (isResponsesUpstream(upstream)) {
            // WS 模式：通过 WebSocket 连接上游
            if (isWSUpstream(upstream)) {
                try {
                    const resolvedModel = upstreamManager.resolveModel(responsesReq.model, upstream.index);
                    const conversationKey = extractConversationKey(req, responsesReq);
                    const wsResult = await createResponsesWS(
                        {...responsesReq, model: resolvedModel},
                        upstream,
                        {contextKey: conversationKey}
                    );

                    if (responsesReq.stream) {
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            Connection: 'keep-alive'
                        });

                        try {
                            for await (const event of wsResult.eventStream) {
                                if (event.type === 'response.completed' && event.data?.response?.usage) {
                                    const usage = event.data.response.usage;
                                    recordUsage(
                                        usage.input_tokens || 0,
                                        usage.output_tokens || 0,
                                        usage.input_tokens_details?.cached_tokens || 0,
                                        responsesReq.model
                                    );
                                }
                                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
                            }
                            releaseWSConnection(wsResult.conn);
                        } catch (err) {
                            discardWSConnection(wsResult.conn);
                            throw err;
                        }
                        res.end();
                    } else {
                        let completedData = null;
                        try {
                            for await (const event of wsResult.eventStream) {
                                if (event.type === 'response.completed') completedData = event.data;
                            }
                            releaseWSConnection(wsResult.conn);
                        } catch (err) {
                            discardWSConnection(wsResult.conn);
                            throw err;
                        }
                        if (completedData?.response) {
                            const usage = completedData.response.usage || {};
                            recordUsage(
                                usage.input_tokens || 0,
                                usage.output_tokens || 0,
                                usage.input_tokens_details?.cached_tokens || 0,
                                responsesReq.model
                            );
                            sendJson(res, 200, completedData.response);
                        } else {
                            sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                        }
                    }
                    return;
                } catch (wsError) {
                    if (wsError instanceof ResponsesWSError) {
                        if (res.headersSent) {
                            if (!res.destroyed && !res.writableEnded) res.end();
                            return;
                        }
                        sendJson(res, wsError.status || 400, wsError.event || {type: 'error', error: {message: wsError.message}});
                        return;
                    }
                    if (res.headersSent) {
                        logger.warn(`Relay Responses: WS stream failed after response started: ${wsError.message}`);
                        if (!res.destroyed && !res.writableEnded) res.end();
                        return;
                    }
                    logger.warn(`Relay Responses: WS failed, falling back to HTTP: ${wsError.message}`);
                    // Fall through to HTTP logic below
                }
            }

            // HTTP 模式：透传
            const conversationKey = extractConversationKey(req, responsesReq);
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(
                    {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, up.index)},
                    up,
                    {
                        requestType: 'ResponsesPassthrough',
                        stream: responsesReq.stream,
                        originalModel: responsesReq.model,
                        ...relayMeta
                    }
                )
            );

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                let usage = null;
                let buffer = '';
                response.body.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    res.write(text);
                    buffer += text;
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (event !== 'response.completed' || !data || data === '[DONE]') continue;
                        try {
                            usage = JSON.parse(data).response?.usage || usage;
                        } catch {
                            continue;
                        }
                    }
                });

                response.body.on('end', () => {
                    recordUsage(
                        usage?.input_tokens || 0,
                        usage?.output_tokens || 0,
                        usage?.input_tokens_details?.cached_tokens || 0,
                        responsesReq.model
                    );
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Relay Responses passthrough stream error:', err);
                    res.end();
                });
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            recordUsage(
                parsed.usage?.input_tokens || 0,
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                responsesReq.model
            );
            sendJson(res, 200, parsed);
            return;
        }

        // OpenAI Chat 上游：Responses → Chat Completions 转换
        const chatReq = responsesRequestToChat(responsesReq);
        chatReq.messages = injectBehaviorRules(chatReq.messages);
        // 剥离纯记账性质的 system-reminder 块
        chatReq.messages = stripDynamicReminders(chatReq.messages);
        const conversationKey = extractConversationKey(req, chatReq);
        const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};

        const {response} = await callUpstream(upstream, (up) => {
            const payload = {...chatReq, model: upstreamManager.resolveModel(chatReq.model, up.index)};
            return createChatCompletions(payload, up, {
                requestType: 'Responses',
                stream: responsesReq.stream,
                originalModel: responsesReq.model,
                ...relayMeta
            });
        });

        if (responsesReq.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;

            response.body.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;

                    let data;
                    try { data = JSON.parse(raw); } catch { continue; }

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                    }

                    const events = chatChunkToResponsesEvents(data, streamState);
                    for (const ev of events) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                recordUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, responsesReq.model);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Relay Responses stream error:', err);
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，聚合后转 Responses 格式
            const {response: streamResp} = await callUpstream(upstream, (up) => {
                const payload = {...chatReq, model: upstreamManager.resolveModel(chatReq.model, up.index), stream: true};
                return createChatCompletions(payload, up, {
                    requestType: 'Responses',
                    stream: false,
                    originalModel: responsesReq.model,
                    ...relayMeta
                });
            });

            const aggregated = await aggregateStreamResponse(streamResp.body);
            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            recordUsage(inputTokens, outputTokens, cacheHitTokens, responsesReq.model);

            const chatResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || chatReq.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: aggregated.content || null,
                        tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                    },
                    finish_reason: aggregated.finishReason || 'stop'
                }],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        logger.error('Relay: Failed to handle Responses API:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Responses Compact 请求 (/relay/v1/responses/compact)
 * 根据上游协议自动选择最优路径：
 * - Anthropic 上游 → 报错引导
 * - Responses 上游 → 直接透传
 * - OpenAI 上游 → Compact→Chat 转换 → Chat→Compact 转回
 */
async function handleResponsesCompact(req, res) {
    try {
        const authResult = getUpstreamOrFail();
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, upstreamManager} = authResult;
        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        if (isAnthropicUpstream(upstream)) {
            sendOpenAIError(res, 400, getProtocolErrorMessage(upstream, 'responses', '/relay/anthropic/v1/messages'));
            return;
        }

        // Responses 上游透传
        if (isResponsesUpstream(upstream)) {
            const conversationKey = extractConversationKey(req, compactReq);
            const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(
                    {...compactReq, model: upstreamManager.resolveModel(compactReq.model, up.index)},
                    up,
                    {
                        requestType: 'ResponsesCompactPassthrough',
                        stream: false,
                        originalModel: compactReq.model,
                        ...relayMeta
                    },
                    'v1/responses/compact'
                )
            );

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            recordUsage(
                parsed.usage?.input_tokens || 0,
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                compactReq.model
            );
            sendJson(res, 200, parsed);
            return;
        }

        // OpenAI Chat 上游：Compact → Chat 转换
        const chatReq = compactRequestToChat(compactReq);
        chatReq.messages = injectBehaviorRules(chatReq.messages);
        // 剥离纯记账性质的 system-reminder 块
        chatReq.messages = stripDynamicReminders(chatReq.messages);
        const conversationKey = extractConversationKey(req, chatReq);
        const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};

        chatReq.stream = true;
        const {response} = await callUpstream(upstream, (up) => {
            const payload = {...chatReq, model: upstreamManager.resolveModel(chatReq.model, up.index)};
            return createChatCompletions(payload, up, {
                requestType: 'ResponsesCompact',
                stream: false,
                originalModel: compactReq.model,
                ...relayMeta
            });
        });

        const aggregated = await aggregateStreamResponse(response.body);
        const inputTokens = aggregated.usage?.prompt_tokens || 0;
        const outputTokens = aggregated.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
        recordUsage(inputTokens, outputTokens, cacheHitTokens, compactReq.model);

        const chatResponse = {
            id: aggregated.id || `chatcmpl_${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: aggregated.model || chatReq.model,
            choices: [{
                index: 0,
                message: {role: 'assistant', content: aggregated.content || null},
                finish_reason: aggregated.finishReason || 'stop'
            }],
            usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
        };

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Relay: Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== WebSocket 端点 ==================== */

/**
 * Relay WS 处理器的核心请求逻辑（提取为独立 async generator）
 * @param {object} payload - 请求体
 * @param {object} upstream - 上游配置
 * @param {object} upstreamManager - 上游管理器
 * @param {AbortSignal} signal - 取消信号
 * @param {http.IncomingMessage} [req] - 原始 HTTP 请求，用于提取 conversationKey 头
 */
async function* _relayWSHandleRequest(payload, upstream, upstreamManager, signal, req = null) {
    const resolvedModel = upstreamManager.resolveModel(payload.model, upstream.index);
    // 推算稳定 conversationKey 用于 prompt_cache_key/contextKey
    const conversationKey = req
        ? extractConversationKey(req, payload)
        : (extractConversationKeyFromPayload(payload) || buildConversationAnchorKey({messages: payload.messages || payload.input}));
    const relayMeta = {conversationKey, sessionId: `session-${ADMIN_USERNAME}`};

    if (isAnthropicUpstream(upstream)) {
        throw Object.assign(new Error('当前上游为 Anthropic 协议，不支持 Responses API'), {
            name: 'ResponsesWSError',
            event: {type: 'error', error: {message: '当前上游为 Anthropic 协议，不支持 Responses API', code: 'protocol_mismatch'}}
        });
    }

    // Responses 上游 + WS：直接 WS 连接上游，转发事件
    if (isWSUpstream(upstream)) {
        const wsPayload = {...payload, model: resolvedModel};
        try {
            const wsResult = await createResponsesWS(wsPayload, upstream, {
                contextKey: conversationKey
            });
            const eventStream = wsResult.eventStream;
            const conn = wsResult.conn;

            // 注意：必须用 finally 释放连接
            // 否则 WS server 在收到 response.completed 后 break，会触发 generator return()，
            // try 块尾部的 releaseWSConnection 永远到不了，连接将一直 busy 烂在池里
            let connHandled = false;
            try {
                for await (const event of eventStream) {
                    if (signal?.aborted) {
                        discardWSConnection(conn);
                        connHandled = true;
                        return;
                    }
                    yield event;
                }
            } catch (err) {
                discardWSConnection(conn);
                connHandled = true;
                throw err;
            } finally {
                if (!connHandled) releaseWSConnection(conn);
            }
            return;
        } catch (wsError) {
            if (wsError instanceof ResponsesWSError) throw wsError;
            logger.warn(`Relay WS: upstream WS failed, falling back to HTTP: ${wsError.message}`);
            // Fall through to HTTP
        }
    }

    // Responses 上游（HTTP）：透传 SSE → WS 事件
    if (isResponsesUpstream(upstream)) {
        const responsesPayload = {...payload, model: resolvedModel};
        const {response} = await callUpstream(upstream, (up) =>
            createResponses(responsesPayload, up, {
                requestType: 'ResponsesWS',
                stream: true,
                originalModel: payload.model,
                ...relayMeta
            })
        );

        // 读取 SSE 流并转换为 WS 事件
        let buffer = '';
        for await (const chunk of response.body) {
            if (signal?.aborted) break;
            buffer += chunk.toString('utf8');
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop() || '';

            for (const part of parts) {
                const {event, data} = parseSSEBlock(part);
                if (!data || data === '[DONE]') continue;
                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }
                yield {type: event || parsed.type, data: parsed};
            }
        }
        return;
    }

    // OpenAI Chat 上游：Chat → Responses 事件转换
    const chatReq = responsesRequestToChat({...payload, model: resolvedModel});
    chatReq.messages = injectBehaviorRules(chatReq.messages);
    // 剥离纯记账性质的 system-reminder 块
    chatReq.messages = stripDynamicReminders(chatReq.messages);
    chatReq.stream = true;

    const {response} = await callUpstream(upstream, (up) =>
        createChatCompletions(chatReq, up, {
            requestType: 'ResponsesWS',
            stream: true,
            originalModel: payload.model,
            ...relayMeta
        })
    );

    const streamState = createResponsesStreamState();
    let buffer = Buffer.alloc(0);

    for await (const chunk of response.body) {
        if (signal?.aborted) break;
        buffer = Buffer.concat([buffer, chunk]);
        let start = 0;
        let newLineIndex;
        while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
            const line = buffer.toString('utf8', start, newLineIndex).trim();
            start = newLineIndex + 1;
            if (!line || line.startsWith(':') || !line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue;

            let data;
            try { data = JSON.parse(raw); } catch { continue; }

            const events = chatChunkToResponsesEvents(data, streamState);
            for (const ev of events) {
                yield {type: ev.event, data: ev.data};
            }
        }
        if (start > 0) buffer = buffer.subarray(start);
    }
}

/**
 * 处理 Relay Responses API WebSocket 连接
 * 客户端通过 WS 连接 /relay/v1/responses，发送标准 Responses API WS 协议
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
export function handleRelayResponsesWS(clientWs, req) {
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            const upstreamManager = relayStore.getUpstreamManager();
            if (!upstreamManager) {
                throw Object.assign(new Error('Relay upstream manager not found'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'Relay upstream manager not found', code: 'server_error'}}
                });
            }

            const upstream = upstreamManager.getActiveUpstream();
            if (!upstream) {
                throw Object.assign(new Error('未配置可用上游'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: '未配置可用上游，请在管理面板 /relayFE 配置', code: 'no_upstream'}}
                });
            }

            yield* _relayWSHandleRequest(payload, upstream, upstreamManager, signal, req);
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            recordUsage(inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
}

/* ==================== 主路由 ==================== */

export async function routeRelayRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/relay' || pathname === '/relay/') {
        sendJson(res, 200, {
            name: 'Relay API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            endpoints: {
                openai: {
                    chatCompletions: 'POST /relay/v1/chat/completions - OpenAI format',
                    responses: 'POST /relay/v1/responses - Responses API',
                    responsesCompact: 'POST /relay/v1/responses/compact - Responses Compact API',
                    models: 'GET /relay/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /relay/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models - Claude format models'
                }
            }
        });
        return;
    }

    if (pathname.startsWith('/relay/anthropic')) {
        const anthropicPath = pathname.replace('/relay/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Relay API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /relay/anthropic/v1/messages',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST')
            return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    if (pathname === '/relay/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/relay/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/relay/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/relay/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
