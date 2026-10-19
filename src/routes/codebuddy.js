/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * 支持 Responses API WebSocket 端点
 * @module routes/codebuddy
 */

import {
    createChatCompletions,
    getModels,
    CodeBuddyApiError,
    upstreamErrorStatus,
    buildGatewayHint
} from '../services/codebuddy/api.js';
import {anthropicToOpenAI, openAIToAnthropic, ClaudeStreamState, SSEWriter} from '../services/codebuddy/translator.js';
import {
    rewriteOpenAIStream,
    injectBehaviorRules,
    extractConversationKey
} from '../transformer/shared-translator.js';
import {
    responsesRequestToChat,
    chatResponseToResponses,
    createResponsesStreamState,
    chatChunkToResponsesEvents,
    compactRequestToChat,
    chatResponseToCompact
} from '../transformer/responses-translator.js';
import {
    getCredential,
    peekCredential,
    indexOfCredential,
    noteUpstreamSuccess,
    noteUpstreamFailure,
    noteStreamOutcome
} from '../services/codebuddy/auth.js';
import {classifyStreamOutcome} from '../services/codebuddy/stream-outcome.js';
import {credentialStore} from '../services/codebuddy/credential-store.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl} from '../services/codebuddy/config.js';
import {handleWSConnection} from '../services/ws/ws-server.js';
import logger from '../utils/logger.js';

/**
 * 从上游 usage 中提取缓存命中 token 数
 * DeepSeek: prompt_cache_hit_tokens
 * OpenAI: prompt_tokens_details.cached_tokens
 */
function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

// 主要是处理codex兼容
export function mapCodebuddyModelName(model) {
    if (!model || typeof model !== 'string') return model;
    const lower = model.toLowerCase();
    if (lower.includes('codex')) return 'deepseek-v4-flash';
    if (lower.startsWith('gpt-')) {
        return lower.includes('mini') ? 'deepseek-v4-flash' : 'kimi-k2.6';
    }
    return model;
}

/**
 * 选择用于统计记录的模型名
 * 优先使用上游返回的模型名，但如果上游返回的是端点 ID（ep- 前缀）等不可读标识，
 * 则回退到客户端请求的模型名
 */
function pickModelName(upstreamModel, clientModel) {
    if (upstreamModel && !upstreamModel.startsWith('ep-')) return upstreamModel;
    return clientModel || upstreamModel;
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送 OpenAI 格式的错误响应
 * @param {number} status
 * @param {string} message
 * @param {string} [type='api_error']
 * @param {string} [hint] - 网关提示，作为并列补充字段（不替换 message）
 */
function sendOpenAIError(res, status, message, type = 'api_error', hint = '') {
    const error = {
        message: message,
        type: type,
        code: status
    };
    if (hint) error.gateway_hint = hint;
    const errorResponse = {error};
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(errorResponse));
}

/**
 * 发送 Anthropic 格式的错误响应
 * @param {number} status
 * @param {string} message
 * @param {string} [hint] - 网关提示，作为并列补充字段（不替换 message）
 */
function sendAnthropicError(res, status, message, hint = '') {
    const error = {
        type: status === 401 ? 'authentication_error' : 'api_error',
        message: message
    };
    if (hint) error.gateway_hint = hint;
    const errorResponse = {type: 'error', error};
    sendJson(res, status, errorResponse);
}

/**
 * 检测并处理上游限速/错误，施加分级冷却
 * 按本次请求实际使用的凭证索引精确归因（替代全局 lastReturnedIndex，避免并发下标记错号）
 * @param {Error} error - 捕获的错误
 * @param {number} [credIndex] - 本次请求使用的凭证索引
 * @param {string} [model] - 本次请求的模型
 */
function handleUpstreamRateLimit(error, credIndex, model) {
    if (error instanceof CodeBuddyApiError) {
        noteUpstreamFailure(error, credIndex, model);
    }
}

/**
 * 流终态归因：把 classifyStreamOutcome 的结果落到账号状态上
 * - 上游 error 帧若带 status/code：构造 CodeBuddyApiError 交给既有分级逻辑（402/404/429/5xx 全部复用）
 * - 其余终态（成功/网络/空流/客户端断开）：走 noteStreamOutcome
 * @param {Object} opts
 * @param {number} opts.credIndex
 * @param {string} [opts.model]
 * @param {string} [opts.sessionKey]
 * @param {Error|null} [opts.error] - 流错误（若有）
 * @param {boolean} [opts.aborted]
 * @param {boolean} [opts.sawUpstreamErrorFrame]
 * @param {boolean} [opts.receivedAnyDelta]
 * @param {Object|null} [opts.errorFrame] - 解析出的上游 error 对象（可能带 status/code）
 */
function accountStreamOutcome({credIndex, model, sessionKey, error = null, aborted = false, sawUpstreamErrorFrame = false, receivedAnyDelta = false, errorFrame = null}) {
    if (!Number.isInteger(credIndex) || credIndex < 0) return;

    // 流被中断（网络错误/客户端断开）优先按中断归因——此时即使之前出现过 error 帧，
    // 也不是"上游业务失败"，不该罚账号
    if (error) {
        const outcome = classifyStreamOutcome({error, aborted, receivedAnyDelta});
        noteStreamOutcome(credIndex, outcome, {sessionKey});
        return;
    }

    // 上游业务错误帧带状态码：复用既有分级（避免 429 被误当 5xx）
    if (errorFrame && (errorFrame.status || errorFrame.code)) {
        handleUpstreamRateLimit(
            new CodeBuddyApiError(errorFrame.status ?? 502, errorFrame.message || 'Upstream error frame', {
                code: errorFrame.code ?? null
            }),
            credIndex,
            model
        );
        return;
    }

    const outcome = classifyStreamOutcome({aborted, sawUpstreamErrorFrame, receivedAnyDelta});
    noteStreamOutcome(credIndex, outcome, {sessionKey});
}

/**
 * 非流式请求成功后：清账号失败计数
 * @param {number} credIndex
 */
function noteNonStreamSuccess(credIndex) {
    noteUpstreamSuccess(credIndex);
}

/**
 * 获取凭证，若无可用凭证则返回错误
 * 网关层已统一完成客户端 API Key 鉴权
 * @param {Object} [opts]
 * @param {string} [opts.sessionKey] - 会话键（用于粘性绑定）
 * @param {string} [opts.model] - 当前请求模型（用于模型级冷却判定）
 */
function getCredentialOrFail(opts) {
    const credential = getCredential(opts);
    if (!credential) {
        return {error: {status: 503, message: 'No available credentials'}};
    }
    return {credential};
}

/**
 * 解析请求体
 */
async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * 处理 OpenAI 格式的 /v1/chat/completions 请求 - 直接透传
 */
async function handleOpenAIChatCompletions(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        // 解析 OpenAI 格式的请求
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);
        openAIPayload.model = mapCodebuddyModelName(openAIPayload.model);
        model = openAIPayload.model;

        // 会话粘性：从原始请求提取会话键，优先复用同一凭证
        sessionKey = extractConversationKey(req, openAIPayload);
        const authResult = getCredentialOrFail({sessionKey, model});
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }
        credIndex = indexOfCredential(authResult.credential);

        // 注入行为规则（统一在路由层注入一次）
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);

        // 直接调用 CodeBuddy API（已经是 OpenAI 格式）
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            sessionKey,
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        // 流式响应：使用 rewriteOpenAIStream 对 reasoning_content 做缓冲合并，避免 thinking 被逐 token 刷成多个块
        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            rewriteOpenAIStream(
                res,
                response.body,
                (inputTokens, outputTokens, cacheHitTokens, credit, model) => {
                    credentialStore.incrementApiCallCount();
                    credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    credentialStore.incrementCreditUsage(credit);
                    credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);
                },
                {
                    // 成功判定延后到流真正结束（而非拿到 200 响应头就记成功）
                    onStreamEnd: (facts) => accountStreamOutcome({credIndex, model, sessionKey, ...facts}),
                    onStreamError: (err, facts) =>
                        accountStreamOutcome({credIndex, model, sessionKey, error: err, aborted: res.destroyed, ...facts})
                }
            );
        } else {
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);
            // 非流式：聚合成功返回后才记成功
            noteNonStreamSuccess(credIndex);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

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
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            sendJson(res, 200, openAIResponse);
        }
    } catch (error) {
        logger.error('Failed to handle OpenAI chat completions:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error', 'api_error', buildGatewayHint(error, model));
    }
}

/**
 * 处理 OpenAI 格式的 /v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        // 模型列表为非聊天查询：只读取号，不推进轮换计数、不参与粘性
        const credential = peekCredential();
        if (!credential) {
            sendOpenAIError(res, 503, 'No available credentials', 'api_error');
            return;
        }

        const modelsData = await getModels(credential);

        // 返回 OpenAI 格式
        sendJson(res, 200, {
            object: 'list',
            data: modelsData.data.map((model) => ({
                id: model.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: model.vendor || 'codebuddy'
            }))
        });
    } catch (error) {
        logger.error('Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        // 解析 Anthropic 格式的请求
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        // 转换为 OpenAI 格式（注意：会话键必须从原始 anthropicPayload 提取，
        // 转换后会丢弃 metadata 且首条 user 内容被改写）
        const openAIPayload = anthropicToOpenAI(anthropicPayload);
        openAIPayload.model = mapCodebuddyModelName(openAIPayload.model);
        model = openAIPayload.model;

        // 会话粘性：从原始请求提取会话键
        sessionKey = extractConversationKey(req, anthropicPayload);
        const authResult = getCredentialOrFail({sessionKey, model});
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        credIndex = indexOfCredential(authResult.credential);

        // 注入行为规则（translateMessages 不再内部注入，统一在路由层注入一次）
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);

        // 调用 CodeBuddy API
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            sessionKey,
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        // 判断是否为流式响应
        if (anthropicPayload.stream) {
            // 流式响应
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
            let streamCredit = 0;
            let streamModel = '';
            let sawUpstreamErrorFrame = false;
            let receivedAnyDelta = false;
            let upstreamErrorFrame = null;

            const responseBody = response.body;

            responseBody.on('data', (chunk) => {
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

                    // 上游业务错误帧（限流/审核等可能伪装成正常结束）
                    if (data.error) {
                        sawUpstreamErrorFrame = true;
                        upstreamErrorFrame = data.error;
                    }

                    const choice = data.choices?.[0];
                    const delta = choice?.delta;
                    if (choice || delta) receivedAnyDelta = true;

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
                    }
                    if (data.model) streamModel = data.model;

                    state.startMessage(data.model);

                    // 提取推理文本：delta.thinking 可能是字符串或对象 { content, signature }
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

                    if (reasoningText) {
                        state.appendThinking(reasoningText);
                    }
                    if (signature) {
                        state.closeThinking(signature);
                    }

                    if (Array.isArray(delta?.tool_calls)) {
                        for (const tool of delta.tool_calls) {
                            const idx = tool.index;
                            if (tool.function?.name) {
                                // 传入 kimi 返回的原始 tool.id，保证 tool_use_id 与上游 tool_call_id 一致
                                // 否则 Claude Code 下一轮 tool_result 携带的 id 将无法被 kimi 识别，导致 invoke model error
                                state.startTool(idx, tool.function.name, tool.id);
                            }
                            if (tool.function?.arguments) {
                                state.appendToolArgs(idx, tool.function.arguments);
                            }
                        }
                    }

                    // 判断是否有推理内容（使用已提取的 reasoningText 避免重复逻辑）
                    if (delta?.content && !reasoningText) {
                        partialTextBuffer += delta.content;
                    }

                    if (choice?.finish_reason) {
                        if (partialTextBuffer) {
                            state.appendText(partialTextBuffer);
                            partialTextBuffer = '';
                        }

                        if (choice.finish_reason === 'tool_calls') {
                            state.finalStopReason = 'tool_use';
                        } else if (choice.finish_reason === 'length') {
                            state.finalStopReason = 'max_tokens';
                        } else {
                            state.finalStopReason = 'end_turn';
                        }
                    }
                }

                if (start > 0) {
                    buffer = buffer.subarray(start);
                }
            });

            responseBody.on('end', () => {
                if (partialTextBuffer) {
                    state.appendText(partialTextBuffer);
                    partialTextBuffer = '';
                }
                state.endMessage(state.finalStopReason, {
                    inputTokens: streamInputTokens,
                    outputTokens: streamOutputTokens,
                    cacheHitTokens: streamCacheHitTokens
                });
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                credentialStore.incrementCreditUsage(streamCredit);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit);
                res.end();
                // 成功判定延后到流真正结束；若中途出现过 error 帧，按上游失败归因
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta,
                    errorFrame: upstreamErrorFrame
                });
            });

            responseBody.on('error', (err) => {
                logger.error('Stream error:', err);
                state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));
                state.finalStopReason = 'error';
                state.endMessage('error');
                res.end();
                // 修复此前"流中途失败不入账"的缺口
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    error: err,
                    aborted: res.destroyed,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta
                });
            });
        } else {
            // 非流式响应
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);
            noteNonStreamSuccess(credIndex);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

            const openAIResponse = {
                id: aggregated.id || `msg_${Date.now()}`,
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
                        finish_reason: aggregated.finishReason || 'stop',
                        logprobs: null
                    }
                ],
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            const anthropicResponse = openAIToAnthropic(openAIResponse);

            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Failed to handle Anthropic messages:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error', buildGatewayHint(error, model));
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        // 本地估算，不调用上游：无需检查凭证
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4);

        sendJson(res, 200, {input_tokens: estimatedTokens});
    } catch (error) {
        logger.error('Failed to count tokens:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        // 模型列表为非聊天查询：只读取号，不推进轮换计数、不参与粘性
        const credential = peekCredential();
        if (!credential) {
            sendAnthropicError(res, 503, 'No available credentials');
            return;
        }

        const modelsData = await getModels(credential);

        sendJson(res, 200, {
            data: modelsData.data.map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'codebuddy',
                name: model.name,
                capabilities: {}
            })),
            object: 'list'
        });
    } catch (error) {
        logger.error('Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI Responses API 请求 (/codebuddy/v1/responses)
 * 将 Responses 格式转为 Chat Completions 发给上游，再将响应转回 Responses 格式
 */
async function handleResponsesAPI(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        // Responses -> Chat Completions
        const chatReq = responsesRequestToChat(responsesReq);
        chatReq.model = mapCodebuddyModelName(chatReq.model);
        model = chatReq.model;

        // 会话粘性：从原始 responsesReq（含 input）提取
        sessionKey = extractConversationKey(req, responsesReq);
        const authResult = getCredentialOrFail({sessionKey, model});
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }
        credIndex = indexOfCredential(authResult.credential);

        chatReq.messages = injectBehaviorRules(chatReq.messages);
        const response = await createChatCompletions(chatReq, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            sessionKey,
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        if (responsesReq.stream) {
            // 流式：解析 Chat SSE -> Responses SSE
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
            let streamCredit = 0;
            let streamModel = '';
            let sawUpstreamErrorFrame = false;
            let receivedAnyDelta = false;
            let upstreamErrorFrame = null;

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

                    // 上游业务错误帧（可能伪装成正常结束）
                    if (data.error) {
                        sawUpstreamErrorFrame = true;
                        upstreamErrorFrame = data.error;
                    }
                    if (data.choices?.[0] || data.usage) receivedAnyDelta = true;

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
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
                // 如果没有正常完成，兜底发送 response.completed
                if (!streamState.started || !streamState.finished) {
                    if (streamState.reasoningOpen) {
                        res.write(`event: response.reasoning_summary_part.done\ndata: ${JSON.stringify({type: 'response.reasoning_summary_part.done', output_index: streamState.outputIndex, summary_index: 0, item_id: streamState.reasoningItemId, part: {type: 'summary_text', text: streamState.reasoningText}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'reasoning', id: streamState.reasoningItemId, status: 'completed', summary: [{type: 'summary_text', text: streamState.reasoningText}]}})}\n\n`);
                        streamState.outputIndex++;
                    }
                    if (streamState.messageOpen) {
                        res.write(`event: response.content_part.done\ndata: ${JSON.stringify({type: 'response.content_part.done', output_index: streamState.outputIndex, content_index: 0, part: {type: 'output_text', text: streamState.textBuffer, annotations: []}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'message', id: streamState.currentMessageId, status: 'completed', role: 'assistant', content: [{type: 'output_text', text: streamState.textBuffer, annotations: []}]}})}\n\n`);
                    }
                    res.write(`event: response.completed\ndata: ${JSON.stringify({type: 'response.completed', response: {id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: streamModel || 'unknown', output: [], usage: {input_tokens: streamInputTokens, output_tokens: streamOutputTokens, total_tokens: streamInputTokens + streamOutputTokens}}})}\n\n`);
                }
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                credentialStore.incrementCreditUsage(streamCredit);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit);
                res.end();
                // 成功判定延后到流真正结束；若中途出现过 error 帧，按上游失败归因
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta,
                    errorFrame: upstreamErrorFrame
                });
            });

            response.body.on('error', (err) => {
                logger.error('Responses stream error:', err);
                res.end();
                // 修复此前"流中途失败不入账"的缺口
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    error: err,
                    aborted: res.destroyed,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta
                });
            });
        } else {
            // 非流式
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);
            noteNonStreamSuccess(credIndex);

            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage?.credit || 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

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
                        reasoning_content: aggregated.reasoningContent || undefined,
                        tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                    },
                    finish_reason: aggregated.finishReason || 'stop'
                }],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        logger.error('Failed to handle Responses API:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error', 'api_error', buildGatewayHint(error, model));
    }
}

/**
 * 处理 OpenAI Responses Compact 请求 (/codebuddy/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        // Compact -> Chat Completions
        const chatReq = compactRequestToChat(compactReq);
        chatReq.model = mapCodebuddyModelName(chatReq.model);
        model = chatReq.model;

        // 会话粘性：从原始 compactReq 提取
        sessionKey = extractConversationKey(req, compactReq);
        const authResult = getCredentialOrFail({sessionKey, model});
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }
        credIndex = indexOfCredential(authResult.credential);

        chatReq.messages = injectBehaviorRules(chatReq.messages);
        const response = await createChatCompletions(chatReq, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            sessionKey
        });

        const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
        const aggregated = await aggregateStreamResponse(response.body);
        // 非流式：聚合成功返回后才记成功
        noteNonStreamSuccess(credIndex);

        const inputTokens = aggregated.usage?.prompt_tokens || 0;
        const outputTokens = aggregated.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
        const credit = aggregated.usage?.credit || 0;
        credentialStore.incrementApiCallCount();
        credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
        credentialStore.incrementCreditUsage(credit);
        credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

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
        logger.error('Failed to handle Responses Compact:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error', 'api_error', buildGatewayHint(error, model));
    }
}

/**
 * 处理凭证管理端点
 */
async function handleCredentials(req, res, method, pathname) {
    const tm = credentialStore.getTokenManager();

    try {
        // GET /v1/credentials - 列出所有凭证
        if (method === 'GET' && pathname === '/v1/credentials') {
            const credentials = tm.getCredentialsInfo();
            sendJson(res, 200, {credentials});
            return;
        }

        // GET /v1/credentials/current - 获取当前凭证
        if (method === 'GET' && pathname === '/v1/credentials/current') {
            const info = tm.getCurrentCredentialInfo();
            sendJson(res, 200, info);
            return;
        }

        // POST /v1/credentials - 添加新凭证
        if (method === 'POST' && pathname === '/v1/credentials') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (!data.bearer_token) {
                sendOpenAIError(res, 400, 'bearer_token is required');
                return;
            }

            // 阻止使用已废弃域名
            try {
                const credentialHost = new URL(getCodebuddyBaseUrl(data.base_url)).host;
                if (BLOCKED_DOMAINS.includes(credentialHost)) {
                    sendOpenAIError(res, 400, `域名 ${credentialHost} 已废弃，不允许添加凭证`);
                    return;
                }
            } catch {
                // base_url 格式无效，由下游处理
            }

            const success = tm.addCredentialWithData(data, data.filename);
            if (success) {
                sendJson(res, 200, {message: 'Credential added successfully'});
            } else {
                sendOpenAIError(res, 500, 'Failed to save credential');
            }
            return;
        }

        // POST /v1/credentials/select - 手动选择凭证
        if (method === 'POST' && pathname === '/v1/credentials/select') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const success = tm.setManualCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} selected successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid credential index');
            }
            return;
        }

        // POST /v1/credentials/auto - 恢复自动轮换
        if (method === 'POST' && pathname === '/v1/credentials/auto') {
            tm.clearManualSelection();
            sendJson(res, 200, {message: 'Resumed automatic credential rotation'});
            return;
        }

        // POST /v1/credentials/toggle-rotation - 切换自动轮换
        if (method === 'POST' && pathname === '/v1/credentials/toggle-rotation') {
            const isEnabled = tm.toggleAutoRotation();
            sendJson(res, 200, {
                message: `Auto rotation ${isEnabled ? 'enabled' : 'disabled'}`,
                auto_rotation_enabled: isEnabled
            });
            return;
        }

        // POST /v1/credentials/delete - 删除凭证
        if (method === 'POST' && pathname === '/v1/credentials/delete') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const success = tm.deleteCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} deleted successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid index or failed to delete credential');
            }
            return;
        }

        sendOpenAIError(res, 404, 'Credential endpoint not found');
    } catch (error) {
        logger.error('Credential management error:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理根路径 - 服务信息
 */
function handleRoot(req, res) {
    const tm = credentialStore.getTokenManager();
    const info = tm.getCurrentCredentialInfo();
    sendJson(res, 200, {
        name: 'WorkBuddy API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic'],
        authenticated: tm.hasCredentials(),
        currentCredential: info,
        endpoints: {
            openai: {
                chatCompletions: 'POST /codebuddy/v1/chat/completions - OpenAI format',
                responses: 'POST /codebuddy/v1/responses - Responses API',
                responsesCompact: 'POST /codebuddy/v1/responses/compact - Responses Compact API',
                models: 'GET /codebuddy/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /codebuddy/anthropic/v1/messages - Claude format',
                countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                models: 'GET /codebuddy/anthropic/v1/models - Claude format models'
            },
            credentials: 'GET/POST /codebuddy/v1/credentials - Manage credentials'
        },
        configuration: {
            autoRotation: tm.autoRotationEnabled,
            rotationCount: tm.rotationCount,
            credsDir: '.codebuddy'
        }
    });
}

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 CodeBuddy Responses API WebSocket 连接
 * 客户端通过 WS 连接 /codebuddy/v1/responses，发送标准 Responses API WS 协议
 * CodeBuddy 上游使用 OpenAI Chat HTTP，服务端做 WS→HTTP→WS 转换
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
export function handleCodebuddyResponsesWS(clientWs, req) {
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            // Responses → Chat Completions 转换（先转换以获得模型名，用于按模型冷却判定）
            const mappedModel = mapCodebuddyModelName(payload.model);
            const chatReq = responsesRequestToChat({...payload, model: mappedModel});

            // 会话粘性：从原始 WS payload 提取会话键
            const sessionKey = extractConversationKey(req, payload);
            const credential = getCredential({sessionKey, model: mappedModel});
            if (!credential) {
                throw Object.assign(new Error('No valid CodeBuddy credentials'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'No valid CodeBuddy credentials', code: 'no_credentials'}}
                });
            }
            const credIndex = indexOfCredential(credential);

            chatReq.messages = injectBehaviorRules(chatReq.messages);
            chatReq.stream = true;
            let response;
            try {
                response = await createChatCompletions(chatReq, {
                    credential,
                    conversationId: req.headers['x-conversation-id'],
                    sessionKey,
                    conversationRequestId: req.headers['x-conversation-request-id'],
                    conversationMessageId: req.headers['x-conversation-message-id'],
                    requestId: req.headers['x-request-id']
                });
            } catch (err) {
                // 上游非 2xx：施加分级冷却（修复此前"标记 429"永不执行的死代码）
                if (err instanceof CodeBuddyApiError) {
                    handleUpstreamRateLimit(err, credIndex, mappedModel);
                }
                throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
                    name: 'ResponsesWSError',
                    event: {
                        type: 'error',
                        error: {
                            message: `Upstream error: ${err?.status || 'unknown'}`,
                            code: 'upstream_error',
                            ...(buildGatewayHint(err, mappedModel)
                                ? {gateway_hint: buildGatewayHint(err, mappedModel)}
                                : {})
                        }
                    }
                });
            }

            // 将 Chat SSE 流转换为 Responses WS 事件
            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);
            let sawUpstreamErrorFrame = false;
            let receivedAnyDelta = false;
            let upstreamErrorFrame = null;
            let streamError = null;
            // 是否把上游流完整读完：被外部 return() 提前终止（客户端关闭）时为 false，
            // 此时不能记成功——那是 client-abort 语义
            let streamCompleted = false;

            try {
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

                        // 上游业务错误帧（可能伪装成正常结束）
                        if (data.error) {
                            sawUpstreamErrorFrame = true;
                            upstreamErrorFrame = data.error;
                        }
                        if (data.choices?.[0] || data.usage) receivedAnyDelta = true;

                        const events = chatChunkToResponsesEvents(data, streamState);
                        for (const ev of events) {
                            yield {type: ev.event, data: ev.data};
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                }
                streamCompleted = !signal?.aborted;
            } catch (err) {
                streamError = err;
                throw err;
            } finally {
                // 成功判定延后到流真正迭代结束（而非拿到 200 响应头就记成功）。
                // 被外部提前终止（客户端关 WS / signal.aborted）时不算成功，按 client-abort 处理。
                accountStreamOutcome({
                    credIndex,
                    model: mappedModel,
                    sessionKey,
                    error: streamError,
                    aborted: !streamCompleted,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta,
                    errorFrame: upstreamErrorFrame
                });
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
}

/**
 * 主路由处理函数
 */
export async function routeCodebuddyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 凭证管理端点（两个模式共用）==========
    if (pathname.startsWith('/codebuddy/v1/credentials')) {
        return handleCredentials(req, res, method, pathname.replace('/codebuddy', ''));
    }

    // ========== Anthropic 模式（Claude 格式）==========
    if (pathname.startsWith('/codebuddy/anthropic')) {
        const anthropicPath = pathname.replace('/codebuddy/anthropic', '');

        if (anthropicPath === '/v1/messages' && method === 'POST') {
            return handleAnthropicMessages(req, res);
        }

        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') {
            return handleAnthropicCountTokens(req, res);
        }

        if (anthropicPath === '/v1/models' && method === 'GET') {
            return handleAnthropicModels(req, res);
        }

        // Anthropic 模式的根路径
        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'WorkBuddy API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /codebuddy/anthropic/v1/messages',
                    countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                    models: 'GET /codebuddy/anthropic/v1/models'
                }
            });
            return;
        }

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式（默认）==========
    // 注意：所有非 anthropic 路径都走 OpenAI 模式

    if (pathname === '/codebuddy/v1/chat/completions' && method === 'POST') {
        return handleOpenAIChatCompletions(req, res);
    }

    if (pathname === '/codebuddy/v1/responses/compact' && method === 'POST') {
        return handleResponsesCompact(req, res);
    }

    if (pathname === '/codebuddy/v1/responses' && method === 'POST') {
        return handleResponsesAPI(req, res);
    }

    if (pathname === '/codebuddy/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // OpenAI 模式的根路径
    if (pathname === '/codebuddy' || pathname === '/codebuddy/' || pathname === '/codebuddy/v1' || pathname === '/codebuddy/v1/') {
        return handleRoot(req, res);
    }

    // 未匹配到任何路由
    sendOpenAIError(res, 404, 'Endpoint not found');
}
