/**
 * 统一格式转换器
 * 参考 claude-code-router 架构
 */

/**
 * 将统一工具转换为 OpenAI 格式工具
 * @param {Array<Object>} tools - 统一工具数组
 * @returns {Array<Object>} OpenAI 格式工具数组
 */
export function convertToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) return [];
    return tools
        .filter((tool) => tool && tool.function)
        .map((tool) => ({
            type: 'function',
            function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters
            }
        }));
}

/**
 * 将统一工具转换为 Anthropic 格式工具
 * @param {Array<Object>} tools - 统一工具数组
 * @returns {Array<Object>} Anthropic 格式工具数组
 */
export function convertToolsToAnthropic(tools) {
    return tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
    }));
}

/**
 * 将 OpenAI 格式工具转换为统一工具
 * @param {Array<Object>} tools - OpenAI 格式工具数组
 * @returns {Array<Object>} 统一工具数组
 */
export function convertToolsFromOpenAI(tools) {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.function.name,
            description: tool.function.description || '',
            parameters: tool.function.parameters
        }
    }));
}

/**
 * 将 Anthropic 格式工具转换为统一工具
 * @param {Array<Object>} tools - Anthropic 格式工具数组
 * @returns {Array<Object>} 统一工具数组
 */
export function convertToolsFromAnthropic(tools) {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema
        }
    }));
}

/**
 * 检查内容是否为工具调用内容
 * @param {string} content - 内容字符串
 * @returns {boolean} 是否为工具调用内容
 */
function isToolCallContent(content) {
    try {
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) && parsed.some((item) => item.type === 'tool_use' && item.id && item.name);
    } catch {
        return false;
    }
}

/**
 * 将统一聊天请求转换为 OpenAI 格式请求
 * @param {Object} request - 统一聊天请求
 * @returns {Object} OpenAI 格式请求
 */
export function convertToOpenAI(request) {
    const messages = [];
    const toolResponsesQueue = new Map(); // 用于存储工具响应

    // 首先收集所有工具响应消息
    request.messages.forEach((msg) => {
        if (msg.role === 'tool' && msg.tool_call_id) {
            if (!toolResponsesQueue.has(msg.tool_call_id)) {
                toolResponsesQueue.set(msg.tool_call_id, []);
            }
            toolResponsesQueue.get(msg.tool_call_id).push({
                role: 'tool',
                content: msg.content,
                tool_call_id: msg.tool_call_id
            });
        }
    });

    // 处理所有消息
    for (let i = 0; i < request.messages.length; i++) {
        const msg = request.messages[i];

        // 跳过工具响应消息（已在队列中处理）
        if (msg.role === 'tool') {
            continue;
        }

        const message = {
            role: msg.role,
            content: msg.content
        };

        // 如果有工具调用，添加到消息中
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            message.tool_calls = msg.tool_calls;
            if (message.content === null) {
                message.content = null;
            }
        }

        messages.push(message);

        // 如果是助手消息且包含工具调用，添加对应的工具响应
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            for (const toolCall of msg.tool_calls) {
                if (toolResponsesQueue.has(toolCall.id)) {
                    const responses = toolResponsesQueue.get(toolCall.id);
                    responses.forEach((response) => {
                        messages.push(response);
                    });
                    toolResponsesQueue.delete(toolCall.id);
                } else {
                    // 如果没有对应的工具响应，添加一个默认响应
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify({
                            success: true,
                            message: 'Tool call executed successfully',
                            tool_call_id: toolCall.id
                        }),
                        tool_call_id: toolCall.id
                    });
                }
            }
        }
    }

    // 处理剩余的工具响应
    if (toolResponsesQueue.size > 0) {
        for (const [id, responses] of toolResponsesQueue.entries()) {
            responses.forEach((response) => {
                messages.push(response);
            });
        }
    }

    const result = {
        messages,
        model: request.model,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        stream: request.stream
    };

    // 添加工具和工具选择
    if (request.tools && request.tools.length > 0) {
        result.tools = convertToolsToOpenAI(request.tools);
        if (request.tool_choice) {
            if (request.tool_choice === 'auto' || request.tool_choice === 'none') {
                result.tool_choice = request.tool_choice;
            } else {
                result.tool_choice = {
                    type: 'function',
                    function: {name: request.tool_choice}
                };
            }
        }
    }

    return result;
}

/**
 * 将 OpenAI 格式请求转换为统一聊天请求
 * @param {Object} request - OpenAI 格式请求
 * @returns {Object} 统一聊天请求
 */
export function convertFromOpenAI(request) {
    const messages = request.messages.map((msg) => {
        // 处理工具调用内容
        if (msg.role === 'assistant' && typeof msg.content === 'string' && isToolCallContent(msg.content)) {
            try {
                const toolCalls = JSON.parse(msg.content);
                const convertedToolCalls = toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input || {})
                    }
                }));

                return {
                    role: msg.role,
                    content: null,
                    tool_calls: convertedToolCalls
                };
            } catch (error) {
                return {
                    role: msg.role,
                    content: msg.content
                };
            }
        }

        // 处理工具响应消息
        if (msg.role === 'tool') {
            return {
                role: msg.role,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                tool_call_id: msg.tool_call_id
            };
        }

        // 处理普通消息
        return {
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            ...(msg.tool_calls && {tool_calls: msg.tool_calls})
        };
    });

    const result = {
        messages,
        model: request.model,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        stream: request.stream
    };

    if (request.tools && request.tools.length > 0) {
        result.tools = convertToolsFromOpenAI(request.tools);

        if (request.tool_choice) {
            if (typeof request.tool_choice === 'string') {
                result.tool_choice = request.tool_choice;
            } else if (request.tool_choice.type === 'function') {
                result.tool_choice = request.tool_choice.function.name;
            }
        }
    }

    return result;
}

/**
 * 将 Anthropic 格式请求转换为统一聊天请求
 * @param {Object} request - Anthropic 格式请求
 * @returns {Object} 统一聊天请求
 */
export function convertFromAnthropic(request) {
    const messages = [];

    // 添加系统消息
    if (request.system) {
        messages.push({
            role: 'system',
            content: request.system
        });
    }

    const pendingToolCalls = [];
    const pendingTextContent = [];
    let lastRole = null;

    for (let i = 0; i < request.messages.length; i++) {
        const msg = request.messages[i];

        // 处理字符串内容
        if (typeof msg.content === 'string') {
            if (lastRole === 'assistant' && pendingToolCalls.length > 0 && msg.role !== 'assistant') {
                const assistantMessage = {
                    role: 'assistant',
                    content: pendingTextContent.join('') || null,
                    tool_calls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined
                };
                if (assistantMessage.tool_calls && pendingTextContent.length === 0) {
                    assistantMessage.content = null;
                }
                messages.push(assistantMessage);
                pendingToolCalls.length = 0;
                pendingTextContent.length = 0;
            }

            messages.push({
                role: msg.role,
                content: msg.content
            });
        } else if (Array.isArray(msg.content)) {
            const textBlocks = [];
            const toolCalls = [];
            const toolResults = [];

            // 处理内容块
            msg.content.forEach((block) => {
                if (block.type === 'text') {
                    textBlocks.push(block.text);
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: JSON.stringify(block.input || {})
                        }
                    });
                } else if (block.type === 'tool_result') {
                    toolResults.push(block);
                }
            });

            // 处理工具结果
            if (toolResults.length > 0) {
                if (lastRole === 'assistant' && pendingToolCalls.length > 0) {
                    const assistantMessage = {
                        role: 'assistant',
                        content: pendingTextContent.join('') || null,
                        tool_calls: pendingToolCalls
                    };
                    if (pendingTextContent.length === 0) {
                        assistantMessage.content = null;
                    }
                    messages.push(assistantMessage);
                    pendingToolCalls.length = 0;
                    pendingTextContent.length = 0;
                }

                toolResults.forEach((toolResult) => {
                    messages.push({
                        role: 'tool',
                        content:
                            typeof toolResult.content === 'string'
                                ? toolResult.content
                                : JSON.stringify(toolResult.content),
                        tool_call_id: toolResult.tool_use_id
                    });
                });
            } else if (msg.role === 'assistant') {
                if (lastRole === 'assistant') {
                    pendingToolCalls.push(...toolCalls);
                    pendingTextContent.push(...textBlocks);
                } else {
                    if (pendingToolCalls.length > 0) {
                        const prevAssistantMessage = {
                            role: 'assistant',
                            content: pendingTextContent.join('') || null,
                            tool_calls: pendingToolCalls
                        };
                        if (pendingTextContent.length === 0) {
                            prevAssistantMessage.content = null;
                        }
                        messages.push(prevAssistantMessage);
                    }

                    pendingToolCalls.length = 0;
                    pendingTextContent.length = 0;
                    pendingToolCalls.push(...toolCalls);
                    pendingTextContent.push(...textBlocks);
                }
            } else {
                if (lastRole === 'assistant' && pendingToolCalls.length > 0) {
                    const assistantMessage = {
                        role: 'assistant',
                        content: pendingTextContent.join('') || null,
                        tool_calls: pendingToolCalls
                    };
                    if (pendingTextContent.length === 0) {
                        assistantMessage.content = null;
                    }
                    messages.push(assistantMessage);
                    pendingToolCalls.length = 0;
                    pendingTextContent.length = 0;
                }

                const message = {
                    role: msg.role,
                    content: textBlocks.join('') || null
                };

                if (toolCalls.length > 0) {
                    message.tool_calls = toolCalls;
                    if (textBlocks.length === 0) {
                        message.content = null;
                    }
                }

                messages.push(message);
            }
        } else {
            if (lastRole === 'assistant' && pendingToolCalls.length > 0) {
                const assistantMessage = {
                    role: 'assistant',
                    content: pendingTextContent.join('') || null,
                    tool_calls: pendingToolCalls
                };
                if (pendingTextContent.length === 0) {
                    assistantMessage.content = null;
                }
                messages.push(assistantMessage);
                pendingToolCalls.length = 0;
                pendingTextContent.length = 0;
            }

            messages.push({
                role: msg.role,
                content: JSON.stringify(msg.content)
            });
        }

        lastRole = msg.role;
    }

    // 处理最后一条助手消息
    if (lastRole === 'assistant' && pendingToolCalls.length > 0) {
        const assistantMessage = {
            role: 'assistant',
            content: pendingTextContent.join('') || null,
            tool_calls: pendingToolCalls
        };
        if (pendingTextContent.length === 0) {
            assistantMessage.content = null;
        }
        messages.push(assistantMessage);
    }

    const result = {
        messages,
        model: request.model,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        stream: request.stream
    };

    if (request.tools && request.tools.length > 0) {
        result.tools = convertToolsFromAnthropic(request.tools);

        if (request.tool_choice) {
            if (request.tool_choice.type === 'auto') {
                result.tool_choice = 'auto';
            } else if (request.tool_choice.type === 'tool') {
                result.tool_choice = request.tool_choice.name;
            }
        }
    }

    return result;
}

/**
 * 通用请求转换函数
 * @param {Object} request - 源格式请求
 * @param {Object} options - 转换选项
 * @returns {Object} 目标格式请求
 */
export function convertRequest(request, options) {
    let unifiedRequest;

    // 将源格式转换为统一格式
    if (options.sourceProvider === 'openai') {
        unifiedRequest = convertFromOpenAI(request);
    } else if (options.sourceProvider === 'anthropic') {
        unifiedRequest = convertFromAnthropic(request);
    } else {
        unifiedRequest = request;
    }

    // 将统一格式转换为目标格式
    if (options.targetProvider === 'openai') {
        return convertToOpenAI(unifiedRequest);
    } else {
        // 暂时返回统一请求，因为Anthropic格式类似
        return unifiedRequest;
    }
}
