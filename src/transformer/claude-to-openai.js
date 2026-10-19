/**
 * Claude → OpenAI Transformer
 * 修复 message_stop 重复问题（Claude Code 兼容）
 */

import {generateId, cleanJsonSchema} from '../utils/helpers.js';
import logger from '../utils/logger.js';
import {convertFromAnthropic, convertToOpenAI} from '../utils/converter.js';
import {injectBehaviorRules} from './shared-translator.js';

/* ================= Utils ================= */

function safeJSONParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

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

        this.messageId = generateId();
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

    endMessage(stopReason = 'end_turn') {
        if (this.messageEnded || !this.messageStarted) return;
        this.messageEnded = true;

        if (this.thinkingOpen) this.closeThinking();
        this.closeAllTools();
        if (this.textOpen) this.closeText();

        this.writer.write('message_delta', {
            type: 'message_delta',
            delta: {stop_reason: stopReason, stop_sequence: null},
            usage: {input_tokens: 0, output_tokens: 0}
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

    startTool(callIndex, name) {
        if (this.toolStates.has(callIndex)) return;

        const blockIndex = this.blockIndex++;
        const toolUseId = generateId();

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

/* ================= Transformer ================= */

export class ClaudeToOpenAITransformer {
    name = 'ClaudeToOpenAI';
    endPoint = '/chat/completions';

    transformRequestOut(claudeRequest) {
        const unified = convertFromAnthropic(claudeRequest);
        const req = convertToOpenAI(unified);

        if (Array.isArray(req.tools)) {
            req.tools = req.tools.map((t) => ({
                ...t,
                function: {
                    ...t.function,
                    parameters: cleanJsonSchema(t.function.parameters)
                }
            }));
        }

        // 注入行为规则到 system message（中文思考规则已收敛到 system 前缀，不在消息中间注入）
        req.messages = injectBehaviorRules(req.messages);

        // 处理 reasoning_effort：从原始 Anthropic 请求中提取 effort 配置
        // 优先级：output_config.effort > thinking 配置推断 > 默认 high
        // haiku 系列不支持 reasoning_effort，跳过注入
        const model = (req.model || '').toLowerCase();
        if (model.includes('haiku')) {
            // haiku 不支持 reasoning_effort，不设置该字段
        } else {
            const thinking = claudeRequest.thinking;
            if (thinking?.type === 'disabled') {
                // thinking 明确关闭，不设置 reasoning_effort
            } else {
                let effort = null;
                const outputEffort = claudeRequest.output_config?.effort;
                if (outputEffort && typeof outputEffort === 'string') {
                    const effortMap = {low: 'low', medium: 'medium', high: 'high', max: 'high'};
                    effort = effortMap[outputEffort.toLowerCase()] || null;
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
                req.reasoning_effort = effort || 'high';
            }
        }

        return req;
    }

    async handleStreamResponse(responseBody, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });

        const writer = new SSEWriter(res);
        const state = new ClaudeStreamState(writer);

        let buffer = '';
        let partialTextBuffer = ''; // 缓存 SSE text

        responseBody.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') continue;

                const data = safeJSONParse(raw);
                if (!data) continue;

                const choice = data.choices?.[0];
                const delta = choice?.delta;

                state.startMessage(data.model);

                /* thinking */
                if (delta?.reasoning_content || delta?.thinking?.content) {
                    state.appendThinking(delta.reasoning_content || delta.thinking.content);
                }
                if (delta?.thinking?.signature) {
                    state.closeThinking(delta.thinking.signature);
                }

                /* tool_calls */
                if (Array.isArray(delta?.tool_calls)) {
                    for (const tool of delta.tool_calls) {
                        const idx = tool.index;
                        if (tool.function?.name) {
                            state.startTool(idx, tool.function.name);
                        }
                        if (tool.function?.arguments) {
                            state.appendToolArgs(idx, tool.function.arguments);
                        }
                    }
                }

                /* text（缓冲直到 finish_reason） */
                if (delta?.content && !delta.reasoning_content && !delta.thinking) {
                    partialTextBuffer += delta.content;
                }

                /* finish_reason 表示消息结束 */
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
        });

        responseBody.on('end', () => {
            // flush未输出 text
            if (partialTextBuffer) {
                state.appendText(partialTextBuffer);
                partialTextBuffer = '';
            }
            state.endMessage(state.finalStopReason);
            res.end();
        });

        responseBody.on('error', (err) => {
            logger.error('Stream error:', err);

            state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));

            state.finalStopReason = 'error';
            state.endMessage('error');
            res.end();
        });
    }

    isStreamResponse(headers) {
        return (headers['content-type'] || '').includes('text/event-stream');
    }

    /**
     * 将 OpenAI 响应转换为 Claude 响应格式（非流式）
     * @param {Object} openaiData - OpenAI 格式的响应数据
     * @returns {Object} Claude 格式的响应数据
     */
    transformResponseIn(openaiData) {
        const choice = openaiData.choices?.[0];
        const message = choice?.message;

        // 构建 Claude 格式的 content 数组
        const content = [];

        // 添加文本内容
        if (message?.content) {
            content.push({
                type: 'text',
                text: message.content
            });
        }

        // 添加工具调用
        if (message?.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                if (toolCall.function) {
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id || generateId(),
                        name: toolCall.function.name,
                        input: safeJSONParse(toolCall.function.arguments) || {}
                    });
                }
            }
        }

        // 转换 stop_reason
        let stopReason = null;
        if (choice?.finish_reason === 'stop') {
            stopReason = 'end_turn';
        } else if (choice?.finish_reason === 'tool_calls') {
            stopReason = 'tool_use';
        } else if (choice?.finish_reason === 'length') {
            stopReason = 'max_tokens';
        }

        return {
            id: openaiData.id || generateId(),
            type: 'message',
            role: 'assistant',
            content,
            model: openaiData.model || this.model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: openaiData.usage || {input_tokens: 0, output_tokens: 0}
        };
    }
}
