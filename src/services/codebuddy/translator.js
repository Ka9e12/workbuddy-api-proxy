/**
 * CodeBuddy Anthropic 到 OpenAI 格式转换模块
 * 复用 OpenAI 兼容接口的流式处理逻辑
 * @module services/codebuddy/translator
 */

import logger from '../../utils/logger.js';
import {cleanJsonSchema} from '../../utils/helpers.js';
import {
    generateId as sharedGenerateId,
    mapStopReason,
    translateToolChoice,
    mapContent,
    injectBehaviorRules,
    prependThinkingHint,
    prependToolThinkingHint,
    openAIToAnthropic as sharedOpenAIToAnthropic,
    normalizeClaudeModelAlias
} from '../../transformer/shared-translator.js';

/* ================= SSE Writer ================= */

class SSEWriter {
    constructor(res) {
        this.res = res;
    }

    write(event, data) {
        this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
}

/* ================= Claude Stream State ================= */

class ClaudeStreamState {
    constructor(writer) {
        this.writer = writer;

        this.messageId = sharedGenerateId();
        this.model = 'claude-3-haiku-20240307';

        this.blockIndex = 0;

        this.messageStarted = false;
        this.messageEnded = false;

        this.finalStopReason = 'end_turn'; // 默认结束原因

        // thinking（支持多段）
        this.thinkingIndex = null;
        this.thinkingOpen = false;

        // text
        this.textIndex = null;
        this.textOpen = false;
        this._textBuffer = '';

        // tool_use（多并行）
        this.toolStates = new Map();
    }

    /* ---------- Message ---------- */

    startMessage(model) {
        if (this.messageStarted) return;
        this.messageStarted = true;
        this.model = model || this.model;

        this.writer.write('message_start', {
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: this.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {input_tokens: 0, output_tokens: 0}
            }
        });
    }

    endMessage(stopReason = 'end_turn', usageTokens = {}) {
        if (this.messageEnded || !this.messageStarted) return;
        this.messageEnded = true;

        if (this.thinkingOpen) this.closeThinking();
        this.closeAllTools();
        if (this.textOpen) this.closeText();

        const usage = {
            input_tokens: usageTokens.inputTokens || 0,
            output_tokens: usageTokens.outputTokens || 0
        };
        if ((usageTokens.cacheHitTokens || 0) > 0) usage.cache_read_input_tokens = usageTokens.cacheHitTokens;
        this.writer.write('message_delta', {
            type: 'message_delta',
            delta: {stop_reason: stopReason, stop_sequence: null},
            usage
        });

        this.writer.write('message_stop', {type: 'message_stop'});
    }

    /* ---------- Thinking (multi-pass) ---------- */

    startThinking() {
        if (this.thinkingOpen) return;
        this.thinkingIndex = this.blockIndex++;
        this.thinkingOpen = true;

        this.writer.write('content_block_start', {
            type: 'content_block_start',
            index: this.thinkingIndex,
            content_block: {type: 'thinking', thinking: ''}
        });
    }

    appendThinking(text) {
        if (!text) return;
        this.startThinking();
        this.writer.write('content_block_delta', {
            type: 'content_block_delta',
            index: this.thinkingIndex,
            delta: {type: 'thinking_delta', thinking: text}
        });
    }

    closeThinking(signature) {
        if (!this.thinkingOpen) return;

        this.writer.write('content_block_delta', {
            type: 'content_block_delta',
            index: this.thinkingIndex,
            delta: {
                type: 'signature_delta',
                signature: signature || Date.now().toString()
            }
        });

        this.writer.write('content_block_stop', {
            type: 'content_block_stop',
            index: this.thinkingIndex
        });

        this.thinkingOpen = false;
        this.thinkingIndex = null;
    }

    /* ---------- Tool Use (parallel) ---------- */

    startTool(callIndex, name, toolId) {
        if (this.toolStates.has(callIndex)) return;

        const blockIndex = this.blockIndex++;
        // 优先使用上游模型返回的原始 tool id，保持 id 一致性
        // 这样 Claude Code 下次请求时携带的 tool_use_id 才能与 kimi 记录的 tool_call_id 对应上
        const toolUseId = toolId || sharedGenerateId();

        this.toolStates.set(callIndex, {
            blockIndex,
            open: true,
            id: toolUseId,
            name
        });

        this.writer.write('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
                type: 'tool_use',
                id: toolUseId,
                name,
                input: {}
            }
        });
    }

    appendToolArgs(callIndex, partial) {
        if (!partial) return;
        const state = this.toolStates.get(callIndex);
        if (!state || !state.open) return;

        this.writer.write('content_block_delta', {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: {
                type: 'input_json_delta',
                partial_json: partial
            }
        });
    }

    closeAllTools() {
        for (const state of this.toolStates.values()) {
            if (!state.open) continue;
            this.writer.write('content_block_stop', {
                type: 'content_block_stop',
                index: state.blockIndex
            });
            state.open = false;
        }
        this.toolStates.clear();
    }

    /* ---------- Text (改写，根源解决重复输出) ---------- */

    startText() {
        if (this.textOpen) return;
        this.textIndex = this.blockIndex++;
        this.textOpen = true;
        this._textBuffer = '';

        this.writer.write('content_block_start', {
            type: 'content_block_start',
            index: this.textIndex,
            content_block: {type: 'text', text: ''}
        });
    }

    appendText(text) {
        if (!text) return;
        this.startText();

        // 累加到 buffer
        this._textBuffer += text;

        this.writer.write('content_block_delta', {
            type: 'content_block_delta',
            index: this.textIndex,
            delta: {type: 'text_delta', text}
        });
    }

    closeText() {
        if (!this.textOpen) return;

        this._textBuffer = '';

        this.writer.write('content_block_stop', {
            type: 'content_block_stop',
            index: this.textIndex
        });

        this.textOpen = false;
        this.textIndex = null;
    }

    /* ---------- Error ---------- */

    emitErrorText(message) {
        if (this.messageEnded) return;

        this.startText();
        this.appendText(message);
        this.closeText();
    }

    /* ---------- Tool Result (Error) ---------- */

    emitToolError(toolUseId, message) {
        const index = this.blockIndex++;

        this.writer.write('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: message,
                error: true
            }
        });

        this.writer.write('content_block_stop', {
            type: 'content_block_stop',
            index
        });
    }
}

export {SSEWriter, ClaudeStreamState};

/**
 * 转换 Anthropic 请求到 OpenAI 格式
 */
export function anthropicToOpenAI(anthropicPayload) {
    const openAIPayload = {
        model: normalizeClaudeModelAlias(anthropicPayload.model),
        messages: translateMessages(anthropicPayload.messages, anthropicPayload.system),
        max_tokens: anthropicPayload.max_tokens,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p,
        stream: anthropicPayload.stream,
        stop: anthropicPayload.stop_sequences
    };

    // 转换 tools
    if (anthropicPayload.tools) {
        openAIPayload.tools = anthropicPayload.tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: cleanJsonSchema(tool.input_schema)
            }
        }));
    }

    // 转换 tool_choice
    if (anthropicPayload.tool_choice) {
        openAIPayload.tool_choice = translateToolChoice(anthropicPayload.tool_choice);
    }

    // reasoning_effort 统一由 resolveThinkingConfig + normalizePayload 处理
    const thinkingConfig = resolveThinkingConfig(anthropicPayload);
    if (thinkingConfig.disabled) {
        // 显式设空字符串，normalizePayload 识别后删除字段、不补默认值
        openAIPayload.reasoning_effort = '';
    } else if (thinkingConfig.effort) {
        openAIPayload.reasoning_effort = thinkingConfig.effort;
    }

    return openAIPayload;
}

/**
 * 从 Anthropic 请求中解析 thinking 配置
 * 返回 { disabled: boolean, effort: string|null }
 *
 * 优先级：output_config.effort > thinking 配置推断 > 默认 high
 */
function resolveThinkingConfig(anthropicPayload) {
    const thinking = anthropicPayload.thinking;

    // thinking.type === 'disabled' 明确关闭思考
    if (thinking?.type === 'disabled') {
        return {disabled: true, effort: ''};
    }

    let effort = null;

    // 1. 优先从 output_config.effort 读取（Claude Code 新版传递方式）
    const outputEffort = anthropicPayload.output_config?.effort;
    if (outputEffort && typeof outputEffort === 'string') {
        const effortMap = {low: 'low', medium: 'medium', high: 'high', max: 'high'};
        const mapped = effortMap[outputEffort.toLowerCase()];
        if (mapped) {
            effort = mapped;
        }
    }

    // 2. 根据 thinking 配置推断
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
 * 转换消息列表
 */
function translateMessages(anthropicMessages, system) {
    const messages = [];

    // 处理 system message（不注入行为规则，最后统一注入）
    if (system) {
        if (typeof system === 'string') {
            messages.push({role: 'system', content: system});
        } else if (Array.isArray(system)) {
            const systemText = system.map((block) => block.text.trim()).join('\n\n');
            if (systemText) {
                messages.push({role: 'system', content: systemText});
            }
        }
    }

    // 处理其他消息
    let lastAssistantMessage = null;
    for (const message of anthropicMessages) {
        if (message.role === 'user') {
            // 传递前一条 assistant 消息，用于按 tool_calls 顺序排列 tool_result
            const userMessages = handleUserMessage(message, lastAssistantMessage);
            messages.push(...userMessages);
            // 处理完 user 消息后，清除 lastAssistantMessage
            // 因为 tool_result 已经处理完毕
            lastAssistantMessage = null;
        } else {
            const assistantMessages = handleAssistantMessage(message);
            messages.push(...assistantMessages);
            // 保存 assistant 消息的 tool_calls 信息，用于下一轮 user 消息的 tool_result 排序
            if (assistantMessages.length > 0 && assistantMessages[0].tool_calls) {
                lastAssistantMessage = assistantMessages[0];
            } else {
                lastAssistantMessage = null;
            }
        }
    }

    return messages;
}

/**
 * 处理用户消息
 */
function handleUserMessage(message, previousAssistantMessage = null) {
    const messages = [];

    if (typeof message.content === 'string') {
        messages.push({role: 'user', content: prependThinkingHint(message.content)});
    } else if (Array.isArray(message.content)) {
        // 分离 tool_result 和其他内容
        const toolResults = message.content.filter((block) => block.type === 'tool_result');
        const otherBlocks = message.content.filter((block) => block.type !== 'tool_result');

        // tool_result 必须先处理
        if (toolResults.length > 0) {
            // 创建 tool_use_id 到 tool_result 的映射
            const resultMap = new Map();
            for (const block of toolResults) {
                let content = '';
                if (typeof block.content === 'string') {
                    content = block.content;
                } else if (block.content != null) {
                    content = JSON.stringify(block.content);
                }
                resultMap.set(block.tool_use_id, prependToolThinkingHint(content));
            }

            // 如果有前一条 assistant 消息，按照 tool_calls 的顺序排列 tool_result
            // 这样可以保证 tool 消息的顺序与 assistant 中的 tool_calls 顺序一致
            if (previousAssistantMessage && previousAssistantMessage.tool_calls) {
                const orderedIds = previousAssistantMessage.tool_calls.map((tc) => tc.id);

                for (const toolId of orderedIds) {
                    if (resultMap.has(toolId)) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolId,
                            content: resultMap.get(toolId)
                        });
                        resultMap.delete(toolId);
                    }
                }
            }

            // 添加剩余的 tool_result（如果有）
            for (const [toolId, content] of resultMap) {
                messages.push({
                    role: 'tool',
                    tool_call_id: toolId,
                    content
                });
            }
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
        return [{role: 'assistant', content: message.content}];
    }

    if (!Array.isArray(message.content)) {
        return [{role: 'assistant', content: null}];
    }

    // 提取不同类型的块
    const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use');
    const textBlocks = message.content.filter((block) => block.type === 'text');
    const thinkingBlocks = message.content.filter((block) => block.type === 'thinking');

    // 只合并文本内容，不包含 thinking 内容
    const allText = textBlocks
        .map((b) => b.text)
        .filter(Boolean)
        .join('\n\n');

    const result = {
        role: 'assistant',
        content: allText || null
    };

    // fix: 将 thinking 转换为 reasoning_content（DeepSeek 和 kimi 要求多轮回传）
    const reasoningText = thinkingBlocks
        .map((b) => b.thinking)
        .filter(Boolean)
        .join('\n\n');
    if (reasoningText) {
        result.reasoning_content = reasoningText;
    }

    // 添加 tool_calls
    if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map((block) => {
            // 确保 input 是有效的对象，避免 JSON.stringify 返回 "null" 或 "undefined"
            let args = '{}';
            if (block.input !== undefined && block.input !== null) {
                try {
                    args = JSON.stringify(block.input);
                } catch (e) {
                    logger.warn(`Failed to stringify tool input for ${block.name}:`, e.message);
                    args = '{}';
                }
            }
            return {
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: args
                }
            };
        });
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

            if (!state.toolCalls[tcIndex]) {
                // 新的 tool call
                if (state.contentBlockOpen) {
                    events.push({
                        type: 'content_block_stop',
                        index: state.contentBlockIndex
                    });
                    state.contentBlockIndex++;
                    state.contentBlockOpen = false;
                }

                state.toolCalls[tcIndex] = {
                    id: toolCall.id || '',
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '',
                    blockIndex: state.contentBlockIndex
                };

                events.push({
                    type: 'content_block_start',
                    index: state.contentBlockIndex,
                    content_block: {
                        type: 'tool_use',
                        id: toolCall.id || '',
                        name: toolCall.function?.name || '',
                        input: {}
                    }
                });
                state.contentBlockOpen = true;
                state.currentBlockType = 'tool_use';
            } else {
                // 追加参数
                if (toolCall.function?.arguments) {
                    state.toolCalls[tcIndex].arguments += toolCall.function.arguments;

                    events.push({
                        type: 'content_block_delta',
                        index: state.toolCalls[tcIndex].blockIndex,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: toolCall.function.arguments
                        }
                    });
                }
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

        events.push({
            type: 'message_delta',
            delta: {
                stop_reason: mapStopReason(choice.finish_reason),
                stop_sequence: null
            },
            usage: {
                output_tokens: openAIChunk.usage?.completion_tokens || 0
            }
        });

        events.push({
            type: 'message_stop'
        });
    }

    return events;
}

/**
 * 转换工具调用 ID (tooluse_xxx -> call_xxx)
 * CodeBuddy 使用 tooluse_xxx 格式，需要转换为 call_xxx 格式以兼容 OpenAI
 */
export function convertToolCallId(codebuddyId) {
    if (codebuddyId && codebuddyId.startsWith('tooluse_')) {
        return `call_${codebuddyId.slice(8)}`;
    }
    return codebuddyId;
}

export {sharedOpenAIToAnthropic as openAIToAnthropic};
export {rewriteOpenAIStream} from '../../transformer/shared-translator.js';
