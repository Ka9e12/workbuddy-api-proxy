/**
 * Anthropic 到 OpenAI 格式转换模块
 * 用于 Claude Code 兼容性
 * @module services/copilot/anthropic-translator
 */

import logger from '../../utils/logger.js';
import {generateId, mapStopReason, translateToolChoice, mapContent, injectBehaviorRules, prependThinkingHint, prependToolThinkingHint, extractCacheHitTokens, openAIToAnthropic as sharedOpenAIToAnthropic, normalizeClaudeModelAlias} from '../../transformer/shared-translator.js';
import {responsesEventToChatChunks} from '../../transformer/responses-translator.js';

/**
 * 转换 Anthropic 请求到 OpenAI 格式
 */
export function anthropicToOpenAI(anthropicPayload) {
    const openAIPayload = {
        model: translateModelName(anthropicPayload.model),
        messages: translateMessages(anthropicPayload.messages, anthropicPayload.system),
        max_tokens: anthropicPayload.max_tokens,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p,
        stream: anthropicPayload.stream,
        stop: anthropicPayload.stop_sequences
    };

    // 转换 tools
    if (anthropicPayload.tools) {
        openAIPayload.tools = anthropicPayload.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema
            }
        }));
    }

    // 转换 tool_choice
    if (anthropicPayload.tool_choice) {
        openAIPayload.tool_choice = translateToolChoice(anthropicPayload.tool_choice);
    }

    // 处理 thinking / reasoning_effort
    // haiku 系列不支持 reasoning_effort，设为空字符串让 normalizePayload 删除该字段
    const model = openAIPayload.model || '';
    if (model.includes('haiku')) {
        openAIPayload.reasoning_effort = '';
    } else {
        const thinkingConfig = resolveThinkingConfig(anthropicPayload);
        if (thinkingConfig.disabled) {
            openAIPayload.reasoning_effort = '';
        } else if (thinkingConfig.effort) {
            openAIPayload.reasoning_effort = thinkingConfig.effort;
        }
        // 否则不设置，让 normalizePayload 默认注入 'high'
    }

    return openAIPayload;
}

/**
 * 从 Anthropic 请求中解析 thinking 配置
 * 返回 { disabled: boolean, effort: string|null }
 */
function resolveThinkingConfig(anthropicPayload) {
    const thinking = anthropicPayload.thinking;

    if (thinking?.type === 'disabled') {
        return {disabled: true, effort: null};
    }

    let effort = null;

    const outputEffort = anthropicPayload.output_config?.effort;
    if (outputEffort && typeof outputEffort === 'string') {
        const effortMap = {low: 'low', medium: 'medium', high: 'high', max: 'high'};
        const mapped = effortMap[outputEffort.toLowerCase()];
        if (mapped) effort = mapped;
    }

    if (!effort && thinking) {
        if (thinking.type === 'adaptive') {
            effort = 'high';
        } else if (thinking.type === 'enabled' && thinking.budget_tokens) {
            if (thinking.budget_tokens <= 4000) effort = 'low';
            else if (thinking.budget_tokens <= 16000) effort = 'medium';
            else effort = 'high';
        }
    }

    return {disabled: false, effort};
}

/**
 * 转换模型名称
 */
function translateModelName(model) {
    const alias = normalizeClaudeModelAlias(model);
    if (typeof alias !== 'string') return alias;
    if (alias.startsWith('claude-sonnet-4-')) {
        return alias.replace(/^claude-sonnet-4-.*/, 'claude-sonnet-4');
    }
    if (alias.startsWith('claude-opus-4-')) {
        return alias.replace(/^claude-opus-4-.*/, 'claude-opus-4');
    }
    return alias;
}

/**
 * 转换消息列表
 */
function translateMessages(anthropicMessages, system) {
    const messages = [];

    // 处理 system message（不注入行为规则，最后统一注入）
    if (system) {
        if (typeof system === 'string') {
            messages.push({ role: 'system', content: system });
        } else if (Array.isArray(system)) {
            // 将带 cache_control 的静态块放在前面，不带 cache_control 的动态块放在末尾
            // 使 OpenAI 兼容 API 能缓存更长的静态前缀（需 ≥1024 tokens）
            const cacheableBlocks = system.filter(b => b.type === 'text' && b.text && b.cache_control);
            const dynamicBlocks = system.filter(b => b.type === 'text' && b.text && !b.cache_control);
            const staticText = cacheableBlocks.map(b => b.text).join('\n\n');
            const dynamicText = dynamicBlocks.map(b => b.text).join('\n\n');
            const parts = [staticText, dynamicText].filter(Boolean);
            if (parts.length > 0) {
                messages.push({ role: 'system', content: parts.join('\n\n') });
            }
        }
    }

    // 处理其他消息
    if (!Array.isArray(anthropicMessages)) {
        return injectBehaviorRules(messages);
    }

    for (const message of anthropicMessages) {
        if (message.role === 'user') {
            messages.push(...handleUserMessage(message));
        } else {
            messages.push(...handleAssistantMessage(message));
        }
    }

    return injectBehaviorRules(messages);
}

/**
 * 处理用户消息
 */
function handleUserMessage(message) {
    const messages = [];

    if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: prependThinkingHint(message.content) });
    } else if (Array.isArray(message.content)) {
        // 分离 tool_result 和其他内容
        const toolResults = message.content.filter(block => block.type === 'tool_result');
        const otherBlocks = message.content.filter(block => block.type !== 'tool_result');

        // tool_result 必须先处理，注入中文思考引导
        for (const block of toolResults) {
            let content = '';
            if (typeof block.content === 'string') {
                content = block.content;
            } else if (block.content != null) {
                content = JSON.stringify(block.content);
            }
            messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: prependToolThinkingHint(content)
            });
        }

        // 处理其他内容，注入思考引导
        if (otherBlocks.length > 0) {
            messages.push({
                role: 'user',
                content: prependThinkingHint(mapContent(otherBlocks))
            });
        }
    }

    return messages;
}

/**
 * 处理助手消息
 */
function handleAssistantMessage(message) {
    if (typeof message.content === 'string') {
        return [{ role: 'assistant', content: message.content }];
    }

    if (!Array.isArray(message.content)) {
        return [{ role: 'assistant', content: null }];
    }

    // 提取不同类型的块
    const toolUseBlocks = message.content.filter(block => block.type === 'tool_use');
    const textBlocks = message.content.filter(block => block.type === 'text');
    const thinkingBlocks = message.content.filter(block => block.type === 'thinking');

    // 合并文本和思考内容
    const allText = [
        ...textBlocks.map(b => b.text),
        ...thinkingBlocks.map(b => b.thinking)
    ].filter(Boolean).join('\n\n');

    const result = {
        role: 'assistant',
        content: allText || null
    };

    // 添加 tool_calls
    if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map(block => ({
            id: block.id,
            type: 'function',
            function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
            }
        }));
    }

    return [result];
}

/**
 * 创建流状态
 */
export function createStreamState() {
    return {
        messageStartSent: false,
        contentBlockOpen: false,
        contentBlockIndex: 0,
        toolCalls: {},
        currentBlockType: null
    };
}

/**
 * 转换流式响应块
 */
export function translateStreamChunk(openAIChunk, state) {
    const events = [];

    if (!openAIChunk.choices || openAIChunk.choices.length === 0) {
        return events;
    }

    const choice = openAIChunk.choices[0];
    const delta = choice.delta;

    // 发送 message_start
    if (!state.messageStartSent) {
        events.push({
            type: 'message_start',
            message: {
                id: openAIChunk.id,
                type: 'message',
                role: 'assistant',
                content: [],
                model: openAIChunk.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: openAIChunk.usage?.prompt_tokens || 0,
                    output_tokens: 0
                }
            }
        });
        state.messageStartSent = true;
    }

    // 处理文本内容
    if (delta.content) {
        // 如果有工具块打开，先关闭它
        if (state.contentBlockOpen && state.currentBlockType === 'tool_use') {
            events.push({
                type: 'content_block_stop',
                index: state.contentBlockIndex
            });
            state.contentBlockIndex++;
            state.contentBlockOpen = false;
        }

        // 打开文本块
        if (!state.contentBlockOpen) {
            events.push({
                type: 'content_block_start',
                index: state.contentBlockIndex,
                content_block: {
                    type: 'text',
                    text: ''
                }
            });
            state.contentBlockOpen = true;
            state.currentBlockType = 'text';
        }

        // 发送文本增量
        events.push({
            type: 'content_block_delta',
            index: state.contentBlockIndex,
            delta: {
                type: 'text_delta',
                text: delta.content
            }
        });
    }

    // 处理 tool_calls
    if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
            const tcIndex = toolCall.index;
            const partialJson = toolCall.function?.arguments || '';

            if (!state.toolCalls[tcIndex]) {
                state.toolCalls[tcIndex] = {
                    id: toolCall.id || '',
                    name: toolCall.function?.name || '',
                    arguments: partialJson,
                    blockIndex: null,
                    emitted: false
                };
            } else {
                if (toolCall.id) state.toolCalls[tcIndex].id = toolCall.id;
                if (toolCall.function?.name) state.toolCalls[tcIndex].name = toolCall.function.name;
                if (partialJson) state.toolCalls[tcIndex].arguments += partialJson;
            }

            const stateToolCall = state.toolCalls[tcIndex];
            if (!stateToolCall.emitted && stateToolCall.name) {
                if (state.contentBlockOpen) {
                    events.push({
                        type: 'content_block_stop',
                        index: state.contentBlockIndex
                    });
                    state.contentBlockIndex++;
                    state.contentBlockOpen = false;
                }

                stateToolCall.id ||= `call_${generateId()}`;
                stateToolCall.blockIndex = state.contentBlockIndex;
                stateToolCall.emitted = true;

                events.push({
                    type: 'content_block_start',
                    index: state.contentBlockIndex,
                    content_block: {
                        type: 'tool_use',
                        id: stateToolCall.id,
                        name: stateToolCall.name,
                        input: {}
                    }
                });
                state.contentBlockOpen = true;
                state.currentBlockType = 'tool_use';

                if (stateToolCall.arguments) {
                    events.push({
                        type: 'content_block_delta',
                        index: stateToolCall.blockIndex,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: stateToolCall.arguments
                        }
                    });
                }
                continue;
            }

            if (stateToolCall.emitted && partialJson) {
                events.push({
                    type: 'content_block_delta',
                    index: stateToolCall.blockIndex,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: partialJson
                    }
                });
            }
        }
    }

    // 处理完成
    if (choice.finish_reason) {
        if (state.contentBlockOpen) {
            events.push({
                type: 'content_block_stop',
                index: state.contentBlockIndex
            });
            state.contentBlockOpen = false;
        }

        const usage = {output_tokens: openAIChunk.usage?.completion_tokens || 0};
        const cacheTokens = extractCacheHitTokens(openAIChunk.usage);
        if (cacheTokens > 0) usage.cache_read_input_tokens = cacheTokens;

        events.push({
            type: 'message_delta',
            delta: {
                stop_reason: mapStopReason(choice.finish_reason),
                stop_sequence: null
            },
            usage
        });

        events.push({
            type: 'message_stop'
        });
    }

    return events;
}

function anthropicContentToResponsesContent(content, textType = 'input_text') {
    if (typeof content === 'string') {
        return [{type: textType, text: content}];
    }

    if (!Array.isArray(content)) {
        return [{type: textType, text: content ? JSON.stringify(content) : ''}];
    }

    return content
        .map((block) => {
            if (!block || typeof block !== 'object') return null;
            if (block.type === 'text') return {type: textType, text: block.text || ''};
            if (block.type === 'image') return {type: 'input_image', image_url: block.source?.data ? `data:${block.source.media_type};base64,${block.source.data}` : block.source?.url || ''};
            if (block.type === 'input_text' || block.type === 'output_text') return {type: textType, text: block.text || ''};
            return block.text ? {type: textType, text: block.text} : null;
        })
        .filter(Boolean);
}

function anthropicMessagesToResponsesInput(messages) {
    const input = [];
    if (!Array.isArray(messages)) return input;

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;

        if (message.role === 'user' && Array.isArray(message.content)) {
            const toolResults = message.content.filter(block => block?.type === 'tool_result');
            const otherBlocks = message.content.filter(block => block?.type !== 'tool_result');

            for (const block of toolResults) {
                input.push({
                    type: 'function_call_output',
                    call_id: block.tool_use_id || '',
                    output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
                });
            }

            if (otherBlocks.length > 0) {
                input.push({
                    role: 'user',
                    content: anthropicContentToResponsesContent(otherBlocks, 'input_text')
                });
            }
            continue;
        }

        if (message.role === 'assistant' && Array.isArray(message.content)) {
            const textBlocks = message.content.filter(block => block?.type === 'text' || block?.type === 'thinking');
            const toolUseBlocks = message.content.filter(block => block?.type === 'tool_use');

            if (textBlocks.length > 0) {
                input.push({
                    role: 'assistant',
                    content: anthropicContentToResponsesContent(textBlocks.map(block => block.type === 'thinking' ? {type: 'text', text: block.thinking || ''} : block), 'output_text')
                });
            }

            for (const block of toolUseBlocks) {
                input.push({
                    type: 'function_call',
                    call_id: block.id || `call_${generateId()}`,
                    name: block.name || '',
                    arguments: JSON.stringify(block.input || {})
                });
            }
            continue;
        }

        input.push({
            role: message.role,
            content: anthropicContentToResponsesContent(message.content, message.role === 'assistant' ? 'output_text' : 'input_text')
        });
    }

    return input;
}

function anthropicSystemToInstructions(system) {
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return undefined;
    const text = system
        .filter(block => block?.type === 'text' && block.text)
        .map(block => block.text)
        .join('\n\n');
    return text || undefined;
}

function anthropicToolChoiceToResponses(toolChoice) {
    if (!toolChoice) return undefined;
    if (toolChoice.type === 'auto' || toolChoice.type === 'any' || toolChoice.type === 'none') return toolChoice.type;
    if (toolChoice.type === 'tool' && toolChoice.name) return {type: 'function', name: toolChoice.name};
    return translateToolChoice(toolChoice);
}

export function anthropicToResponses(anthropicPayload) {
    const responsesPayload = {
        model: translateModelName(anthropicPayload.model),
        input: anthropicMessagesToResponsesInput(anthropicPayload.messages),
        stream: anthropicPayload.stream,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p
    };

    const instructions = anthropicSystemToInstructions(anthropicPayload.system);
    if (instructions) responsesPayload.instructions = instructions;

    if (anthropicPayload.max_tokens !== undefined) {
        responsesPayload.max_output_tokens = anthropicPayload.max_tokens;
    }

    const thinkingConfig = resolveThinkingConfig(anthropicPayload);
    if (!thinkingConfig.disabled && thinkingConfig.effort) {
        responsesPayload.reasoning = {effort: thinkingConfig.effort};
    }

    if (Array.isArray(anthropicPayload.tools) && anthropicPayload.tools.length > 0) {
        responsesPayload.tools = anthropicPayload.tools.map(tool => ({
            type: 'function',
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || {}
        }));
    }

    const toolChoice = anthropicToolChoiceToResponses(anthropicPayload.tool_choice);
    if (toolChoice) responsesPayload.tool_choice = toolChoice;

    if (anthropicPayload.stop_sequences) responsesPayload.stop = anthropicPayload.stop_sequences;
    if (anthropicPayload.metadata) responsesPayload.metadata = anthropicPayload.metadata;

    return responsesPayload;
}

/**
 * 将 Responses API 完整响应转换为 Anthropic Messages API 响应格式
 * 用于非流式场景
 */
export function responsesOutputToAnthropic(responsesRes) {
    const content = [];

    for (const item of responsesRes.output || []) {
        if (item.type === 'message' && item.role === 'assistant') {
            for (const c of item.content || []) {
                if (c.type === 'output_text') {
                    content.push({type: 'text', text: c.text || ''});
                }
            }
        } else if (item.type === 'function_call') {
            let input = {};
            try {
                input = JSON.parse(item.arguments || '{}');
            } catch {
                // 保留原始字符串
            }
            content.push({
                type: 'tool_use',
                id: item.call_id || `toolu_${generateId()}`,
                name: item.name || '',
                input
            });
        } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            const summaryText = item.summary
                .filter(s => s.type === 'summary_text' && s.text)
                .map(s => s.text)
                .join('\n\n');
            if (summaryText) {
                content.push({type: 'thinking', thinking: summaryText});
            }
        }
    }

    if (content.length === 0) {
        content.push({type: 'text', text: ''});
    }

    // 根据 Responses status 和内容推断 stop_reason
    let stopReason = 'end_turn';
    const hasToolUse = content.some(b => b.type === 'tool_use');
    if (hasToolUse) {
        stopReason = 'tool_use';
    } else if (responsesRes.status === 'incomplete') {
        stopReason = 'max_tokens';
    }

    return {
        id: responsesRes.id?.replace(/^resp_/, 'msg_') || `msg_${generateId()}`,
        type: 'message',
        role: 'assistant',
        content,
        model: responsesRes.model || '',
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: responsesRes.usage?.input_tokens || 0,
            output_tokens: responsesRes.usage?.output_tokens || 0,
            cache_read_input_tokens: responsesRes.usage?.input_tokens_details?.cached_tokens || 0
        }
    };
}

export {sharedOpenAIToAnthropic as openAIToAnthropic};

export function responsesEventToAnthropicEvents(eventType, eventData, chatState, anthropicState) {
    const chatChunks = responsesEventToChatChunks(eventType, eventData, chatState);
    const anthropicEvents = [];
    for (const chunk of chatChunks) {
        const events = translateStreamChunk(chunk, anthropicState);
        anthropicEvents.push(...events);
    }
    return anthropicEvents;
}
