/**
 * Copilot 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/copilot
 */

import {ensureCopilotToken, isAuthenticated} from '../services/copilot/auth.js';
import {createChatCompletions, createResponsesWS, releaseWSConnection, discardWSConnection, getModels} from '../services/copilot/copilot-api.js';
import {copilotState} from '../services/copilot/state.js';
import {copilotStore} from '../services/copilot/copilot-store.js';
import {readBody, isNetworkError} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    anthropicToResponses,
    openAIToAnthropic,
    translateStreamChunk,
    createStreamState,
    responsesEventToAnthropicEvents
} from '../services/copilot/anthropic-translator.js';
import {
    responsesRequestToChat,
    chatRequestToResponses,
    chatResponseToResponses,
    responsesResponseToChat,
    createResponsesStreamState,
    createChatCompletionsStreamState,
    chatChunkToResponsesEvents,
    responsesEventToChatChunks,
    responsesEventToResponsesEvents,
    convertResponsesUsageToChat,
    compactRequestToChat,
    chatResponseToCompact,
    sanitizeResponsesInput
} from '../transformer/responses-translator.js';
import {
    estimateMessageTokens,
    estimateContentBlockTokens
} from '../utils/token-estimation.js';
import {aggregateStreamResponse} from '../services/codebuddy/api.js';
import {ResponsesWSError} from '../services/ws/ws-client.js';
import {handleWSConnection} from '../services/ws/ws-server.js';
import logger from '../utils/logger.js';

/* ==================== 工具函数 ==================== */

/**
 * 从上游 usage 中提取缓存命中 token 数
 */
function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

function extractProxyFromHeaders(req) {
    // 优先从 store 读取代理配置
    const storeProxy = copilotStore.getProxyUrl();
    if (storeProxy) return storeProxy;

    // 兼容：从请求头读取（仅本地请求）
    const proxy = req.headers['x-copilot-proxy'];
    if (!proxy) return undefined;
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        return proxy;
    }
    return undefined;
}

function getCopilotNetworkOptions(req) {
    return {
        proxyUrl: extractProxyFromHeaders(req),
        rejectUnauthorized: copilotStore.getRejectUnauthorized()
    };
}

function normalizeConversationKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractConversationKeyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;

    const metadata = payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : undefined;

    const candidates = [
        payload.conversation_id,
        payload.conversationId,
        payload.session_id,
        payload.sessionId,
        payload.thread_id,
        payload.threadId,
        metadata?.conversation_id,
        metadata?.conversationId,
        metadata?.session_id,
        metadata?.sessionId,
        metadata?.thread_id,
        metadata?.threadId
    ];

    for (const candidate of candidates) {
        const normalized = normalizeConversationKey(candidate);
        if (normalized) return normalized;
    }

    return undefined;
}

function extractConversationKey(req, payload) {
    const headerCandidates = [
        req.headers['x-conversation-id'],
        req.headers['x-session-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeConversationKey(value);
        if (normalized) return normalized;
    }

    return extractConversationKeyFromPayload(payload);
}

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

function isResponsesProtocolError(err) {
    return err instanceof ResponsesWSError && err?.event?.type === 'error';
}

function sendResponsesProtocolError(res, err) {
    const event = err?.event || {
        type: 'error',
        status: err?.status || 400,
        error: {
            message: err?.message || 'Responses WebSocket request failed'
        }
    };

    if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        }
        return;
    }

    sendJson(res, event.status || err?.status || 400, event);
}

function upstreamErrorStatus(err) {
    return isNetworkError(err) ? 502 : 500;
}

export function supportsResponsesWebSocket(model) {
    return typeof model === 'string' && /^gpt(?:-|$)/i.test(model.trim());
}

function ensureResponsesWebSocketSupported(model) {
    if (!supportsResponsesWebSocket(model)) {
        throw new Error(`Responses WebSocket is only supported for GPT-series models: ${model || 'unknown'}`);
    }
}

/**
 * API Key 鉴权（已移除，统一由网关层处理）
 */

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/* ==================== 鉴权 ==================== */

/**
 * 确保 Copilot 上游认证有效（GitHub 登录 + Copilot Token）
 * 网关层已统一完成客户端 API Key 鉴权
 */
async function ensureCopilotAuth(networkOptions = {}) {
    // Copilot 认证检查
    if (!isAuthenticated()) {
        return {error: {status: 401, message: 'Not authenticated. Please visit /copilotFE to authenticate with GitHub.'}};
    }

    try {
        const proxyUrl = 'proxyUrl' in networkOptions ? networkOptions.proxyUrl : copilotStore.getProxyUrl();
        const copilotToken = await ensureCopilotToken(proxyUrl, networkOptions);
        return {copilotToken};
    } catch (error) {
        return {error: {status: 503, message: error.message}};
    }
}

/* ==================== OpenAI 模式 ==================== */

/**
 * 处理 OpenAI 格式的 /copilot/v1/chat/completions 请求
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        logger.info(`Copilot OpenAI request - model: ${openAIPayload.model}, stream: ${openAIPayload.stream}`);

        const conversationKey = extractConversationKey(req, openAIPayload);

        // Chat → Responses 格式
        const responsesReq = chatRequestToResponses(openAIPayload);

        try {
            ensureResponsesWebSocketSupported(responsesReq.model);
            const wsResult = await createResponsesWS(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                responsesReq,
                copilotState.accountType,
                proxyUrl,
                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
            );

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatState = createChatCompletionsStreamState();
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;

                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed' && event.data?.response?.usage) {
                            const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                            streamInputTokens = chatUsage.prompt_tokens || 0;
                            streamOutputTokens = chatUsage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                        }
                        const chatChunks = responsesEventToChatChunks(event.type, event.data, chatState);
                        for (const chunk of chatChunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }
                    res.write('data: [DONE]\n\n');
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (streamInputTokens > 0 || streamOutputTokens > 0) {
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                } else {
                    copilotStore.incrementApiCallCount();
                    const estimated = estimateMessageTokens(openAIPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                res.end();
            } else {
                let completedData = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            completedData = event.data;
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (completedData?.response) {
                    const chatResponse = responsesResponseToChat(completedData.response);
                    const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                    const outputTokens = chatResponse.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
                    sendJson(res, 200, chatResponse);
                } else {
                    sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                }
            }
        } catch (wsError) {
            if (res.headersSent) {
                logger.warn(`Copilot OpenAI: WS stream failed after response started: ${wsError.message}`);
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
                return;
            }

            logger.warn(`Copilot OpenAI: WS failed, falling back to HTTP POST: ${wsError.message}`);

            const response = await createChatCompletions(
                copilotState.copilotToken,
                copilotState.vsCodeVersion,
                openAIPayload,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                let lineBuffer = '';

                response.body.on('data', (chunk) => {
                    res.write(chunk);
                    lineBuffer += chunk.toString('utf8');
                    const lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data: ')) continue;
                        const raw = trimmed.slice(6).trim();
                        if (raw === '[DONE]') continue;
                        try {
                            const data = JSON.parse(raw);
                            if (data.usage) {
                                streamInputTokens = data.usage.prompt_tokens || 0;
                                streamOutputTokens = data.usage.completion_tokens || 0;
                                streamCacheHitTokens = extractCacheHitTokens(data.usage);
                            }
                        } catch {}
                    }
                });

                response.body.on('end', () => {
                    if (lineBuffer.trim()) {
                        res.write(lineBuffer);
                    }
                    if (streamInputTokens > 0 || streamOutputTokens > 0) {
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    } else {
                        copilotStore.incrementApiCallCount();
                        const estimated = estimateMessageTokens(openAIPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Copilot OpenAI stream error (fallback):', err);
                    res.end();
                });

                res.on('close', () => {
                    if (response.body && !response.body.destroyed) {
                        response.body.destroy();
                    }
                });
            } else {
                const responseBody = await readBody(response.body);
                let parsed;
                try {
                    parsed = JSON.parse(responseBody);
                } catch {
                    sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                    return;
                }
                const inputTokens = parsed.usage?.prompt_tokens || 0;
                const outputTokens = parsed.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(parsed.usage);
                copilotStore.incrementApiCallCount();
                if (inputTokens > 0 || outputTokens > 0) {
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
                } else {
                    const estimated = estimateMessageTokens(openAIPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                sendJson(res, 200, parsed);
            }
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI 格式的 /copilot/v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            copilotState.accountType,
            proxyUrl,
            networkOptions
        );

        sendJson(res, 200, {
            object: 'list',
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot'
            }))
        });
    } catch (error) {
        logger.error('Copilot: Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Anthropic 模式 ==================== */

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        logger.info(`Copilot Anthropic request - model: ${anthropicPayload.model}, stream: ${anthropicPayload.stream}`);

        const conversationKey = extractConversationKey(req, anthropicPayload);

        const responsesReq = anthropicToResponses(anthropicPayload);

        try {
            ensureResponsesWebSocketSupported(responsesReq.model);
            const wsResult = await createResponsesWS(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                responsesReq,
                copilotState.accountType,
                proxyUrl,
                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
            );

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatState = createChatCompletionsStreamState();
                const anthropicState = createStreamState();
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;

                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed' && event.data?.response?.usage) {
                            const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                            streamInputTokens = chatUsage.prompt_tokens || 0;
                            streamOutputTokens = chatUsage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                        }
                        const anthropicEvents = responsesEventToAnthropicEvents(
                            event.type, event.data, chatState, anthropicState
                        );
                        for (const ev of anthropicEvents) {
                            if (res.destroyed) break;
                            res.write(`event: ${ev.type}\n`);
                            res.write(`data: ${JSON.stringify(ev)}\n\n`);
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (streamInputTokens > 0 || streamOutputTokens > 0) {
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                } else {
                    copilotStore.incrementApiCallCount();
                    const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                if (!res.destroyed) res.end();
            } else {
                let completedData = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            completedData = event.data;
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (completedData?.response) {
                    const chatResponse = responsesResponseToChat(completedData.response);
                    const anthropicResponse = openAIToAnthropic(chatResponse);
                    const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                    const outputTokens = chatResponse.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                    copilotStore.incrementApiCallCount();
                    if (inputTokens > 0 || outputTokens > 0) {
                        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
                    } else {
                        const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    sendJson(res, 200, anthropicResponse);
                } else {
                    sendAnthropicError(res, 502, 'No response.completed event received from upstream');
                }
            }
        } catch (wsError) {
            if (res.headersSent) {
                logger.warn(`Copilot Anthropic: WS stream failed after response started: ${wsError.message}`);
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
                return;
            }

            logger.warn(`Copilot Anthropic: WS failed, falling back to HTTP POST: ${wsError.message}`);

            const openAIPayload = anthropicToOpenAI(anthropicPayload);
            const response = await createChatCompletions(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                openAIPayload,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendAnthropicError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const state = createStreamState();
                let buffer = '';
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;

                const processLines = (lines) => {
                    for (const line of lines) {
                        if (res.destroyed) return;

                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const data = trimmedLine.slice(6);

                            if (data === '[DONE]') {
                                continue;
                            }

                            try {
                                const openAIChunk = JSON.parse(data);
                                const anthropicEvents = translateStreamChunk(openAIChunk, state);

                                if (openAIChunk.usage) {
                                    streamInputTokens = openAIChunk.usage.prompt_tokens || streamInputTokens;
                                    streamOutputTokens = openAIChunk.usage.completion_tokens || streamOutputTokens;
                                    streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage) || streamCacheHitTokens;
                                }

                                for (const event of anthropicEvents) {
                                    if (res.destroyed) return;
                                    res.write(`event: ${event.type}\n`);
                                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                                }
                            } catch (e) {
                                logger.error('Failed to parse chunk:', e);
                            }
                        }
                    }
                };

                response.body.on('data', (chunk) => {
                    try {
                        if (res.destroyed) return;

                        buffer += chunk.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        processLines(lines);
                    } catch (error) {
                        logger.error('Stream processing error:', error);
                    }
                });

                response.body.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            processLines([buffer]);
                        } catch (error) {
                            logger.error('Failed to process remaining buffer:', error);
                        }
                        buffer = '';
                    }
                    if (streamInputTokens > 0 || streamOutputTokens > 0) {
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    } else {
                        copilotStore.incrementApiCallCount();
                        const estimated = estimateMessageTokens(openAIPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    if (!res.destroyed) {
                        res.end();
                    }
                });

                response.body.on('error', (error) => {
                    logger.error('Stream error (fallback):', error);
                    if (!res.destroyed) {
                        res.end();
                    }
                });

                res.on('close', () => {
                    if (response.body && !response.body.destroyed) {
                        response.body.destroy();
                    }
                });
            } else {
                const responseBody = await readBody(response.body);
                const openAIResponse = JSON.parse(responseBody);
                const anthropicResponse = openAIToAnthropic(openAIResponse);
                const inputTokens = openAIResponse.usage?.prompt_tokens || 0;
                const outputTokens = openAIResponse.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(openAIResponse.usage);
                copilotStore.incrementApiCallCount();
                if (inputTokens > 0 || outputTokens > 0) {
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
                } else {
                    const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                sendJson(res, 200, anthropicResponse);
            }
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        let totalTokens = 0;

        if (Array.isArray(anthropicPayload.messages)) {
            totalTokens += estimateMessageTokens(anthropicPayload.messages);
        }

        if (anthropicPayload.system) {
            if (typeof anthropicPayload.system === 'string') {
                totalTokens += Math.ceil(anthropicPayload.system.length / 4);
            } else if (Array.isArray(anthropicPayload.system)) {
                for (const block of anthropicPayload.system) {
                    totalTokens += estimateContentBlockTokens(block);
                }
            }
        }

        if (Array.isArray(anthropicPayload.tools)) {
            for (const tool of anthropicPayload.tools) {
                totalTokens += Math.ceil((tool.name || '').length / 4);
                totalTokens += Math.ceil((tool.description || '').length / 4);
                if (tool.input_schema) {
                    const schemaStr = JSON.stringify(tool.input_schema);
                    totalTokens += Math.ceil(schemaStr.length / 2);
                }
            }
        }

        sendJson(res, 200, {input_tokens: totalTokens});
    } catch (error) {
        logger.error('Copilot: Failed to count tokens:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            copilotState.accountType,
            proxyUrl,
            networkOptions
        );

        sendJson(res, 200, {
            object: 'list',
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot',
                name: model.name,
                capabilities: model.capabilities || {}
            }))
        });
    } catch (error) {
        logger.error('Copilot: Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses API 模式 ==================== */

/**
 * 处理 OpenAI Responses API 请求 (/copilot/v1/responses)
 */
async function handleResponsesAPI(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        logger.info(`Copilot Responses request - model: ${responsesReq.model}, stream: ${responsesReq.stream}`);

        const conversationKey = extractConversationKey(req, responsesReq);

        // 净化 input：去除上游 WS 无法解析的 id 引用（CherryStudio 续接对话时带入的 output item id）
        if (Array.isArray(responsesReq.input)) {
            responsesReq.input = sanitizeResponsesInput(responsesReq.input);
        }

        // WS 通道：直接发送 Responses 格式
        try {
            ensureResponsesWebSocketSupported(responsesReq.model);
            const wsResult = await createResponsesWS(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                responsesReq,
                copilotState.accountType,
                proxyUrl,
                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
            );

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatState = createChatCompletionsStreamState();
                const responsesState = createResponsesStreamState();
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;

                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed' && event.data?.response?.usage) {
                            const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                            streamInputTokens = chatUsage.prompt_tokens || 0;
                            streamOutputTokens = chatUsage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                        }
                        const responseEvents = responsesEventToResponsesEvents(event.type, event.data, chatState, responsesState);
                        for (const ev of responseEvents) {
                            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                copilotStore.incrementApiCallCount();
                copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                res.end();
            } else {
                let completedData = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            completedData = event.data;
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (completedData?.response) {
                    const usage = completedData.response.usage || {};
                    const chatUsage = convertResponsesUsageToChat(usage);
                    const inputTokens = chatUsage.prompt_tokens || 0;
                    const outputTokens = chatUsage.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatUsage);
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
                    sendJson(res, 200, completedData.response);
                } else {
                    sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                }
            }
        } catch (wsError) {
            if (isResponsesProtocolError(wsError)) {
                logger.warn(`Copilot Responses: WS protocol error: ${wsError.message}`);
                sendResponsesProtocolError(res, wsError);
                return;
            }

            if (res.headersSent) {
                logger.warn(`Copilot Responses: WS stream failed after response started: ${wsError.message}`);
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
                return;
            }

            logger.warn(`Copilot Responses: WS failed, falling back to HTTP POST: ${wsError.message}`);

            const chatReq = responsesRequestToChat(responsesReq);
            const response = await createChatCompletions(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                chatReq,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

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
                let streamModel = '';

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
                        if (data.model) streamModel = data.model;

                        const events = chatChunkToResponsesEvents(data, streamState);
                        for (const ev of events) {
                            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                });

                response.body.on('end', () => {
                    if (!streamState.started || !streamState.finished) {
                        if (streamState.reasoningOpen) {
                            const item = {type: 'reasoning', id: streamState.reasoningItemId, status: 'completed', summary: [{type: 'summary_text', text: streamState.reasoningText}]};
                            res.write(`event: response.reasoning_summary_part.done\ndata: ${JSON.stringify({type: 'response.reasoning_summary_part.done', output_index: streamState.outputIndex, summary_index: 0, item_id: streamState.reasoningItemId, part: {type: 'summary_text', text: streamState.reasoningText}})}\n\n`);
                            res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item})}\n\n`);
                            streamState.output.push(item);
                            streamState.outputIndex++;
                        }
                        if (streamState.messageOpen) {
                            const item = {type: 'message', id: streamState.currentMessageId, status: 'completed', role: 'assistant', content: [{type: 'output_text', text: streamState.textBuffer, annotations: []}]};
                            res.write(`event: response.content_part.done\ndata: ${JSON.stringify({type: 'response.content_part.done', output_index: streamState.outputIndex, content_index: 0, part: {type: 'output_text', text: streamState.textBuffer, annotations: []}})}\n\n`);
                            res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item})}\n\n`);
                            streamState.output.push(item);
                        }
                        res.write(`event: response.completed\ndata: ${JSON.stringify({type: 'response.completed', response: {id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: streamModel || 'unknown', output: streamState.output, usage: {input_tokens: streamInputTokens, output_tokens: streamOutputTokens, total_tokens: streamInputTokens + streamOutputTokens}}})}\n\n`);
                    }
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Responses stream error (fallback):', err);
                    res.end();
                });
            } else {
                const responseBody = await readBody(response.body);
                const chatResponse = JSON.parse(responseBody);

                const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                const outputTokens = chatResponse.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                copilotStore.incrementApiCallCount();
                copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);

                sendJson(res, 200, chatResponseToResponses(chatResponse));
            }
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Responses API:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses Compact API ==================== */

/**
 * 处理 OpenAI Responses Compact 请求 (/copilot/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        // Compact -> Chat Completions
        const chatReq = compactRequestToChat(compactReq);

        const response = await createChatCompletions(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            chatReq,
            copilotState.accountType,
            proxyUrl,
            networkOptions
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        const responseBody = await readBody(response.body);
        const chatResponse = JSON.parse(responseBody);

        const inputTokens = chatResponse.usage?.prompt_tokens || 0;
        const outputTokens = chatResponse.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
        copilotStore.incrementApiCallCount();
        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Copilot: Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 Copilot Responses API WebSocket 连接
 * 客户端通过 WS 连接 /copilot/v1/responses，发送标准 Responses API WS 协议
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
export function handleCopilotResponsesWS(clientWs, req) {
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            // Copilot 认证
            if (!isAuthenticated()) {
                throw Object.assign(new Error('Not authenticated. Please visit /copilotFE to authenticate with GitHub.'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'Not authenticated', code: 'unauthorized'}}
                });
            }

            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;

            try {
                const copilotToken = await ensureCopilotToken(proxyUrl, networkOptions);
                const conversationKey = extractConversationKey(req, payload);

                // 净化 input
                if (Array.isArray(payload.input)) {
                    payload = {...payload, input: sanitizeResponsesInput(payload.input)};
                }

                // 尝试 WS 模式（GPT 系列模型）
                if (supportsResponsesWebSocket(payload.model)) {
                    try {
                        const wsResult = await createResponsesWS(
                            copilotToken,
                            copilotState.vsCodeVersion,
                            payload,
                            copilotState.accountType,
                            proxyUrl,
                            {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
                        );

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
                        logger.warn(`Copilot WS: WS failed, falling back to HTTP: ${wsError.message}`);
                    }
                }

                // HTTP 回退：Responses → Chat Completions → Responses 事件转换
                const chatReq = responsesRequestToChat(payload);
                chatReq.stream = true;

                const response = await createChatCompletions(
                    copilotToken,
                    copilotState.vsCodeVersion,
                    chatReq,
                    copilotState.accountType,
                    proxyUrl,
                    networkOptions
                );

                if (response.status >= 400) {
                    const errorBody = await readBody(response.body);
                    throw Object.assign(new Error(`Upstream error: ${errorBody.slice(0, 500)}`), {
                        name: 'ResponsesWSError',
                        event: {type: 'error', error: {message: `Upstream error: ${response.status}`, code: 'upstream_error'}}
                    });
                }

                // 将 Chat SSE 流转换为 Responses WS 事件
                const streamState = createResponsesStreamState();
                const chatState = createChatCompletionsStreamState();
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
            } catch (error) {
                logger.error('Copilot WS: handleRequest error:', error);
                throw error;
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            copilotStore.incrementApiCallCount();
            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
        }
    });
}

/* ==================== 根路径 ==================== */

function handleRoot(req, res) {
    sendJson(res, 200, {
        name: 'GitHub Copilot API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic', 'responses'],
        authenticated: isAuthenticated(),
        user: copilotState.userInfo,
        endpoints: {
            openai: {
                chatCompletions: 'POST /copilot/v1/chat/completions - OpenAI format',
                responses: 'POST /copilot/v1/responses - OpenAI Responses API',
                responsesCompact: 'POST /copilot/v1/responses/compact - Responses Compact API',
                models: 'GET /copilot/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /copilot/anthropic/v1/messages - Claude format',
                countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                models: 'GET /copilot/anthropic/v1/models - Claude format models'
            }
        },
        configuration: {
            tokenSource: isAuthenticated() ? '.copilot/github_token' : 'not configured'
        }
    });
}

/* ==================== 主路由 ==================== */

export async function routeCopilotRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    logger.info(`Copilot request: ${method} ${pathname}`);

    // ========== Anthropic 模式 ==========
    if (pathname.startsWith('/copilot/anthropic')) {
        const anthropicPath = pathname.replace('/copilot/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Copilot API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /copilot/anthropic/v1/messages',
                    countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                    models: 'GET /copilot/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式 ==========
    if (pathname === '/copilot/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/copilot/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/copilot/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/copilot/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    // ========== 根路径 ==========
    if (pathname === '/copilot' || pathname === '/copilot/') return handleRoot(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
