/**
 * 公共 Translator 逻辑
 * 抽取自 Copilot/CodeBuddy translator 的重复代码
 * @module transformer/shared-translator
 */

import {randomBytes} from 'crypto';
import logger from '../utils/logger.js';
import {getBehaviorRules} from '../config/system-prompts.js';

/**
 * 从 OpenAI 格式 usage 中提取缓存命中 token 数
 * DeepSeek: prompt_cache_hit_tokens
 * OpenAI: prompt_tokens_details.cached_tokens
 */
export function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

/**
 * 生成唯一 ID
 */
export function generateId() {
    return randomBytes(16).toString('hex');
}

/**
 * 映射 OpenAI stop reason 到 Anthropic 格式
 */
export function mapStopReason(finishReason) {
    const mapping = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
        content_filter: 'end_turn'
    };
    return mapping[finishReason] || null;
}

/**
 * 转换 tool_choice
 */
export function translateToolChoice(anthropicToolChoice) {
    if (!anthropicToolChoice) {
        return undefined;
    }

    if (anthropicToolChoice.type === 'auto') {
        return 'auto';
    }
    if (anthropicToolChoice.type === 'any') {
        return 'required';
    }
    if (anthropicToolChoice.type === 'tool') {
        return {
            type: 'function',
            function: {name: anthropicToolChoice.name}
        };
    }

    return undefined;
}

export function normalizeClaudeModelAlias(model) {
    return model;
}

/**
 * 将 base64 编码的文档内容解码为文本
 * 支持 PDF、纯文本、代码文件等
 */
function decodeDocumentToText(block) {
    const source = block.source;
    if (!source || source.type !== 'base64' || !source.data) {
        return null;
    }

    const mediaType = (source.media_type || '').toLowerCase();

    // 纯文本类文件：直接 base64 解码
    const textMediaTypes = [
        'text/plain',
        'text/markdown',
        'text/csv',
        'text/html',
        'text/xml',
        'text/css',
        'text/javascript',
        'text/x-python',
        'text/x-java',
        'text/x-c',
        'text/x-cpp',
        'text/x-shellscript',
        'text/x-yaml',
        'text/x-json',
        'text/x-toml',
        'text/x-rust',
        'application/json',
        'application/xml',
        'application/javascript',
        'application/x-yaml',
        'application/x-sh'
    ];
    if (textMediaTypes.includes(mediaType)) {
        try {
            return Buffer.from(source.data, 'base64').toString('utf8');
        } catch {
            return null;
        }
    }

    // PDF: 尝试提取文本，失败则回退为 base64 image_url
    if (mediaType === 'application/pdf') {
        try {
            const pdfBuffer = Buffer.from(source.data, 'base64');
            const text = extractPDFText(pdfBuffer);
            if (text && text.trim().length > 0) {
                return text;
            }
        } catch {
            // PDF 文本提取失败，回退
        }
        // 无法提取文本，将 PDF 作为 base64 data URL 传递
        return null;
    }

    // 未知类型：尝试 base64 解码为文本
    try {
        const decoded = Buffer.from(source.data, 'base64').toString('utf8');
        // 简单判断是否包含大量不可打印字符（二进制文件）
        const nonPrintable = decoded.split('').filter((c) => {
            const code = c.charCodeAt(0);
            return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
        }).length;
        if (nonPrintable / decoded.length < 0.1) {
            return decoded;
        }
    } catch {}

    return null;
}

/**
 * 从 PDF Buffer 中提取纯文本
 * 使用简单的正则匹配方式，无需外部依赖
 */
function extractPDFText(buffer) {
    const text = buffer.toString('latin1');

    // 提取括号内文本对象 (PDF 文本对象格式: (text) Tj 或 [(text1)(text2)] TJ)
    const texts = [];
    const parenRegex = /\(([^\\)]*(?:\\.[^\\)]*)*)\)/g;
    let match;
    while ((match = parenRegex.exec(text)) !== null) {
        const raw = match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\');
        if (raw.trim().length > 0) {
            texts.push(raw);
        }
    }

    return texts.join('\n');
}

/**
 * 映射内容块
 * 支持 text、image、document（PDF/文本文件）类型
 */
export function mapContent(blocks) {
    if (blocks.length === 1 && blocks[0].type === 'text') {
        return blocks[0].text;
    }

    const mapped = blocks
        .map((block) => {
            if (block.type === 'text') {
                return {type: 'text', text: block.text};
            }
            if (block.type === 'image') {
                return {
                    type: 'image_url',
                    image_url: {
                        url:
                            block.source.type === 'base64'
                                ? `data:${block.source.media_type};base64,${block.source.data}`
                                : block.source.url
                    }
                };
            }
            if (block.type === 'document') {
                const extractedText = decodeDocumentToText(block);
                if (extractedText) {
                    return {type: 'text', text: extractedText};
                }
                // 无法提取文本，将文档作为 base64 data URL 传递
                const source = block.source;
                if (source && source.type === 'base64' && source.data) {
                    return {
                        type: 'image_url',
                        image_url: {
                            url: `data:${source.media_type || 'application/octet-stream'};base64,${source.data}`
                        }
                    };
                }
                return null;
            }
            if (block.text) {
                return {type: 'text', text: block.text};
            }
            return null;
        })
        .filter(Boolean);

    if (mapped.length === 0) {
        return '';
    }

    return mapped;
}

/**
 * 透传用户消息内容，不在中间注入任何标记
 * 中文思考规则已完全收敛到 system 前缀中，避免中间注入打断缓存前缀匹配
 */
export function prependThinkingHint(content) {
    return content;
}

/**
 * 透传工具返回结果内容，不在中间注入任何标记
 */
export function prependToolThinkingHint(content) {
    return content;
}

/**
 * 将行为规则注入到 OpenAI 格式的 messages 数组中
 * 如果存在 system 消息则前置，否则新建
 * 不在消息中间插入内容，以保持缓存前缀连续性
 *
 * 缓存优化：
 * 1. 剥离客户端 system 中的动态内容（x-tencent-billing-header 等），追加到
 *    messages 最后一条 user 消息尾部，避免动态内容破坏 system 前缀一致性
 * 2. 检测客户端 system 是否已包含代理行为规则，避免重复注入
 * @param {Array} messages - OpenAI 格式的 messages 数组
 * @returns {Array} 注入后的 messages 数组
 */
export function injectBehaviorRules(messages) {
    const behaviorRules = getBehaviorRules();
    const result = [];

    const systemIndex = messages.findIndex((m) => m.role === 'system');

    if (systemIndex >= 0) {
        const originalSystem = messages[systemIndex].content;
        const systemStr =
            typeof originalSystem === 'string' ? originalSystem : originalSystem.map((p) => p.text ?? '').join('\n');
        // 客户端 system 已包含代理行为规则时跳过注入，避免重复
        const alreadyHasRules = systemStr.includes('<proxy:thinking>');
        // 剥离动态行（如 x-tencent-billing-header），保持 system 前缀稳定
        // 动态行直接丢弃：它们的值每次请求都变（如 cch=xxx 哈希），
        // 即使追加到 user 消息尾部也会污染 messages 前缀导致缓存 miss
        const stableContent = extractStableContent(systemStr);
        const systemPrefix = alreadyHasRules ? '' : behaviorRules + '\n\n';
        result.push({...messages[systemIndex], content: systemPrefix + stableContent});

        for (let i = 0; i < messages.length; i++) {
            if (i === systemIndex) continue;
            result.push(messages[i]);
        }
    } else {
        result.push({role: 'system', content: behaviorRules});
        for (const m of messages) result.push(m);
    }

    return result;
}

/**
 * 从 system 内容中提取稳定部分，丢弃动态行
 * 动态行 = <proxy:xxx> 标签外的非空行，且匹配 header/key-value 格式
 * 这些行由客户端注入（billing header、session 信息等），每次请求值不同
 * 直接丢弃而非追加到 user 消息，避免动态内容污染 messages 前缀导致缓存 miss
 */
function extractStableContent(systemContent) {
    // 统一换行符：CRLF → LF，避免不同抓包工具产生不一致的过滤结果
    const normalized = systemContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const stableLines = [];
    let insideProxyTag = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('<proxy:') && trimmed.endsWith('>')) {
            insideProxyTag = true;
            stableLines.push(line);
            continue;
        }
        if (insideProxyTag && trimmed.startsWith('</proxy:')) {
            insideProxyTag = false;
            stableLines.push(line);
            continue;
        }
        if (insideProxyTag) {
            stableLines.push(line);
            continue;
        }
        if (trimmed === '') {
            stableLines.push(line);
            continue;
        }
        if (isDynamicLine(trimmed)) continue;
        stableLines.push(line);
    }

    let result = stableLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();

    // 段落去重：harness 可能重复注入相同的提示段落
    // 段落 = 被空行分隔的非空文本块
    // 当检测到重复段落时，意味着 harness 开始重复注入系统提示前缀，
    // 此段落及之后的所有内容都应截断丢弃，避免后续被污染的内容混入
    const parts = result.split(/(\n\n+)/);
    const out = [];
    let pendingSep = '';
    const seen = new Set();
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
            const p = parts[i].trimEnd();
            if (!p) { pendingSep = ''; continue; }
            if (seen.has(p)) break;
            seen.add(p);
            if (out.length > 0) out.push(pendingSep);
            out.push(p);
        } else {
            pendingSep = parts[i];
        }
    }
    result = out.join('');

    return result.trimEnd();
}

function isDynamicLine(line) {
    // HTTP header 格式的动态行（如 x-anthropic-billing-header）
    if (/^x-[a-z]/i.test(line)) return true;
    // 已知的动态字段
    if (/^(currentDate|currentDateIso|sessionId|memory):/i.test(line)) return true;
    // harness 动态注入的行（可能因无空行分隔而与上一个段落合并）
    if (/^The task tools haven't been used/i.test(line)) return true;
    if (/^Here are the existing tasks:/i.test(line)) return true;
    if (/^#\d+\.\s*\[/i.test(line)) return true;
    return false;
}

/**
 * 递归排序对象 key，确保相同内容产生相同的 JSON 序列化
 * 上游 prompt caching 要求请求前缀逐字节一致，嵌套对象 key 顺序不同会导致 miss
 */
function sortObjectKeys(obj) {
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
    if (obj !== null && typeof obj === 'object') {
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortObjectKeys(obj[key]);
        }
        return sorted;
    }
    return obj;
}

/**
 * 将 JSON 字符串重新序列化为 key 排序的版本
 * 确保 DeepSeek/Kimi 前缀匹配缓存不因嵌入 JSON 的 key 顺序不同而 miss
 * 非法 JSON 或非对象/数组开头的字符串原样返回
 */
function sortJsonString(str) {
    if (!str || typeof str !== 'string') return str;
    const first = str[0];
    if (first !== '{' && first !== '[') return str;
    try {
        const parsed = JSON.parse(str);
        return JSON.stringify(sortObjectKeys(parsed));
    } catch {
        return str;
    }
}

/**
 * 消息对象字段顺序
 * 确保 JSON.stringify 时消息对象输出稳定，DeepSeek/Kimi 前缀匹配缓存不因 key 顺序不同而 miss
 */
const MESSAGE_FIELD_ORDER = ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id', 'name'];

/**
 * 标准化消息数组，确保相同语义内容产生相同字节序列
 * DeepSeek 和 Kimi 使用前缀匹配缓存，messages 前缀必须逐字节一致
 *
 * 优化点：
 * 1. 消息对象字段排序：确保 JSON.stringify 输出稳定
 * 2. system 消息：行尾空白去除、换行统一、多余空行合并
 * 3. assistant.tool_calls.arguments：JSON key 排序
 * 4. tool 消息 content：如果是 JSON，key 排序
 */
function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map(msg => {
        // 1. 字段排序：确保 JSON.stringify 输出稳定
        const ordered = {};
        for (const key of MESSAGE_FIELD_ORDER) {
            if (msg[key] !== undefined) ordered[key] = msg[key];
        }
        for (const key of Object.keys(msg)) {
            if (!(key in ordered)) ordered[key] = msg[key];
        }

        // 2. system 消息空白统一
        if (ordered.role === 'system' && typeof ordered.content === 'string') {
            ordered.content = ordered.content
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .replace(/[ \t]+$/gm, '')
                .replace(/\n{3,}/g, '\n\n')
                .trimEnd();
        }

        // 3. assistant.tool_calls.arguments key 排序
        if (ordered.role === 'assistant' && Array.isArray(ordered.tool_calls)) {
            ordered.tool_calls = ordered.tool_calls.map(tc => ({
                id: tc.id,
                type: tc.type || 'function',
                function: {
                    name: tc.function?.name,
                    arguments: sortJsonString(tc.function?.arguments)
                }
            }));
        }

        // 4. tool 消息 content key 排序
        if (ordered.role === 'tool' && typeof ordered.content === 'string') {
            ordered.content = sortJsonString(ordered.content);
        }

        return ordered;
    });
}

/**
 * 统一 payload 字段顺序和默认值，确保相同内容产生相同字节序列
 * 上游 prompt caching 要求请求前缀逐字节一致，字段顺序不同会导致缓存 miss
 */
const FIELD_ORDER = [
    'model',
    'messages',
    'tools',
    'tool_choice',
    'max_tokens',
    'temperature',
    'top_p',
    'reasoning_effort',
    'thinking',
    'stream',
    'stream_options',
    'stop'
];

export function normalizePayload(payload, meta = {}) {
    const ordered = {};
    for (const key of FIELD_ORDER) {
        if (payload[key] !== undefined) ordered[key] = payload[key];
    }
    for (const key of Object.keys(payload)) {
        if (!(key in ordered)) ordered[key] = payload[key];
    }

    // 空字符串 '' 表示用户明确关闭 thinking，不注入默认值，也不发送给上游
    if (ordered.reasoning_effort === '') {
        delete ordered.reasoning_effort;
    } else if (ordered.reasoning_effort === undefined) {
        // haiku 系列不支持 reasoning_effort，跳过默认注入
        const m = (ordered.model || '').toLowerCase();
        if (!m.includes('haiku')) {
            ordered.reasoning_effort = 'high';
        }
    }
    if (ordered.stream && !ordered.stream_options) {
        ordered.stream_options = {include_usage: true};
    }

    // tools 排序：递归排序 key + 按 function.name 排序，保证 JSON.stringify 输出稳定
    if (ordered.tools) {
        ordered.tools = ordered.tools
            .map((t) => sortObjectKeys(t))
            .sort((a, b) => (a.function?.name || '').localeCompare(b.function?.name || ''));
    }

    // 消息标准化：确保 DeepSeek/Kimi 前缀匹配缓存能命中
    // - 消息对象字段排序，确保 JSON.stringify 输出稳定
    // - tool_calls.arguments / tool content 的 JSON key 排序
    // - system 消息空白统一
    if (ordered.messages) {
        ordered.messages = normalizeMessages(ordered.messages);
    }

    return ordered;
}

/**
 * 转换 OpenAI 响应到 Anthropic 格式
 */
export function openAIToAnthropic(openAIResponse) {
    const choice = openAIResponse.choices?.[0];
    if (!choice) {
        return {
            id: openAIResponse.id || generateId(),
            type: 'message',
            role: 'assistant',
            model: openAIResponse.model || 'unknown',
            content: [{type: 'text', text: 'Empty response from upstream API'}],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: openAIResponse.usage?.prompt_tokens || 0,
                output_tokens: openAIResponse.usage?.completion_tokens || 0,
                cache_read_input_tokens: extractCacheHitTokens(openAIResponse.usage)
            }
        };
    }

    const message = choice.message || {};
    const content = [];

    if (message.content) {
        content.push({
            type: 'text',
            text: message.content
        });
    }

    if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
            let parsedInput = {};
            try {
                parsedInput = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                logger.warn('Failed to parse tool call arguments:', toolCall.function?.arguments?.slice(0, 200));
                parsedInput = {};
            }
            content.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                input: parsedInput
            });
        }
    }

    if (content.length === 0) {
        content.push({type: 'text', text: ''});
    }

    return {
        id: openAIResponse.id,
        type: 'message',
        role: 'assistant',
        model: openAIResponse.model,
        content: content,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openAIResponse.usage?.prompt_tokens || 0,
            output_tokens: openAIResponse.usage?.completion_tokens || 0,
            cache_read_input_tokens: extractCacheHitTokens(openAIResponse.usage)
        }
    };
}

/**
 * 将上游 OpenAI 格式的流式 SSE 数据重写后输出给客户端
 * 核心修复：对 reasoning_content 做缓冲合并，避免 thinking 被逐 token 刷成多个独立块
 *
 * @param {http.ServerResponse} res - 客户端响应
 * @param {ReadableStream} responseBody - 上游流
 * @param {Function} onUsage - usage 统计回调 (inputTokens, outputTokens, cacheHitTokens, credit, model)
 * @param {Object} [hooks] - 可选终态回调（不传时行为与既有完全一致）
 * @param {Function} [hooks.onStreamEnd] - 流正常结束，入参 {receivedAnyDelta, sawUpstreamErrorFrame}
 * @param {Function} [hooks.onStreamError] - 流错误中断，入参 (err, {receivedAnyDelta, sawUpstreamErrorFrame})
 *   注意：这里只回传"事实"，终态归类由调用方（codebuddy 路由层）负责——避免 transformer 反向依赖上层模块。
 */
export function rewriteOpenAIStream(res, responseBody, onUsage, hooks = {}) {
    let reasoningBuffer = ''; // 缓冲 reasoning_content 片段
    let lineBuffer = '';
    let streamInputTokens = 0;
    let streamOutputTokens = 0;
    let streamCacheHitTokens = 0;
    let streamCredit = 0;
    let streamModel = '';
    let sawUpstreamErrorFrame = false;
    let receivedAnyDelta = false;
    let upstreamErrorFrame = null;

    function flushReasoning() {
        if (!reasoningBuffer) return;
        const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: streamModel || 'unknown',
            choices: [
                {
                    index: 0,
                    delta: {role: 'assistant', reasoning_content: reasoningBuffer},
                    finish_reason: null
                }
            ]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        reasoningBuffer = '';
    }

    responseBody.on('data', (chunk) => {
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) {
                res.write(line + '\n');
                continue;
            }
            if (!trimmed.startsWith('data: ')) {
                res.write(line + '\n');
                continue;
            }

            const raw = trimmed.slice(6).trim();
            if (raw === '[DONE]') {
                flushReasoning();
                res.write('data: [DONE]\n\n');
                continue;
            }

            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                res.write(line + '\n');
                continue;
            }

            // 上游业务错误帧（限流/审核等可能伪装成正常结束）：标记后按终态归类处理
            if (data.error) {
                sawUpstreamErrorFrame = true;
                upstreamErrorFrame = data.error;
            }

            // 提取 usage
            if (data.usage) {
                streamInputTokens = data.usage.prompt_tokens || 0;
                streamOutputTokens = data.usage.completion_tokens || 0;
                streamCacheHitTokens =
                    data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0;
                streamCredit = data.usage.credit || 0;
            }
            if (data.model) streamModel = data.model;

            const choice = data.choices?.[0];
            const delta = choice?.delta;
            if (!choice || !delta) {
                res.write(line + '\n');
                continue;
            }

            // 记录确实收到了有效内容帧（用于区分"上游静默返回 200 但零帧"）
            receivedAnyDelta = true;

            // 提取 reasoning 文本
            let reasoningText = null;
            if (delta.reasoning_content) {
                reasoningText = delta.reasoning_content;
            } else if (typeof delta.thinking === 'string') {
                reasoningText = delta.thinking;
            } else if (typeof delta.thinking === 'object' && delta.thinking !== null) {
                reasoningText = delta.thinking.content || null;
            }

            if (reasoningText) {
                // 缓冲 reasoning，不立即输出
                reasoningBuffer += reasoningText;
                continue;
            }

            // 遇到非 reasoning 内容（content/tool_calls/finish_reason），先 flush 缓冲的 reasoning
            if (delta.content || Array.isArray(delta.tool_calls) || choice.finish_reason) {
                flushReasoning();
            }

            // 正常内容直接透传
            res.write(line + '\n');
        }
    });

    responseBody.on('end', () => {
        flushReasoning();
        if (lineBuffer.trim()) {
            res.write(lineBuffer + '\n');
        }
        if (onUsage) {
            onUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit, streamModel);
        }
        res.end();
        if (hooks.onStreamEnd) hooks.onStreamEnd({receivedAnyDelta, sawUpstreamErrorFrame, errorFrame: upstreamErrorFrame});
    });

    responseBody.on('error', (err) => {
        logger.error('OpenAI stream rewrite error:', err);
        flushReasoning();
        res.end();
        if (hooks.onStreamError) hooks.onStreamError(err, {receivedAnyDelta, sawUpstreamErrorFrame, errorFrame: upstreamErrorFrame});
    });
}

/**
 * 剥离消息中的动态 system-reminder 块
 */
export function stripDynamicReminders(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(msg => {
        if (typeof msg.content === 'string') {
            return {
                ...msg,
                content: msg.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
            };
        }
        if (Array.isArray(msg.content)) {
            return {
                ...msg,
                content: msg.content.filter(block => {
                    if (block.type === 'text' && /<system-reminder>/i.test(block.text)) {
                        return false;
                    }
                    return true;
                })
            };
        }
        return msg;
    });
}

/**
 * 根据 payload 生成稳定的 conversation anchor key
 */
export function buildConversationAnchorKey(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const messages = payload.messages || payload.input || [];
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const firstUser = messages.find(m => m.role === 'user');
    if (!firstUser) return null;
    const content = typeof firstUser.content === 'string'
        ? firstUser.content
        : JSON.stringify(firstUser.content);
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return 'anchor-' + Math.abs(hash).toString(36);
}

/**
 * 归一化 conversation key — 去 trim，空串返 undefined
 * （与 buildConversationAnchorKey 同属"会话键推算"，供 relay / copilot / codebuddy 三后端共用）
 */
export function normalizeConversationKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 从 payload 中提取已显式声明的 conversation/session/thread id
 */
export function extractConversationKeyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;
    const candidates = [
        payload.conversation_id, payload.conversationId,
        payload.session_id, payload.sessionId,
        payload.thread_id, payload.threadId,
        metadata?.conversation_id, metadata?.conversationId,
        metadata?.session_id, metadata?.sessionId,
        metadata?.thread_id, metadata?.threadId,
        // Anthropic 标准字段：Claude Code 会带 metadata.user_id
        metadata?.user_id, metadata?.userId
    ];
    for (const candidate of candidates) {
        const normalized = normalizeConversationKey(candidate);
        if (normalized) return normalized;
    }
    return undefined;
}

/**
 * 从请求头、payload、anchor 三个来源依次推算稳定的 conversation key
 * 优先级：头（x-conversation-id 等） > payload 显式字段 > buildConversationAnchorKey(第一条 user)
 * @param {object} req - HTTP 请求（含 headers）
 * @param {object} payload - 请求体（Anthropic / OpenAI / Responses 任一形态）
 * @returns {string|undefined}
 */
export function extractConversationKey(req, payload) {
    const headers = req?.headers || {};
    const headerCandidates = [
        headers['x-conversation-id'],
        headers['x-session-id'],
        headers['x-chat-id'],
        headers['x-thread-id']
    ];
    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeConversationKey(value);
        if (normalized) return normalized;
    }
    const payloadResult = extractConversationKeyFromPayload(payload);
    if (payloadResult) return payloadResult;
    const anchorPayload = payload && typeof payload === 'object'
        ? {...payload, messages: payload?.messages || payload?.input}
        : {messages: payload?.messages || payload?.input};
    return buildConversationAnchorKey(anchorPayload);
}
