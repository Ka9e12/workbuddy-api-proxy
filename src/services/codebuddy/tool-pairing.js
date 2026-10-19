/**
 * 工具调用消息配对清理
 *
 * 与"工具调用参数完整性"（单个 arguments 字符串是否为合法 JSON）是**不同维度**：
 * 本条管的是 messages 序列里 `assistant.tool_calls[].id` 与 `role:'tool'` 消息的
 * `tool_call_id` 的**配对关系**。上游在转码/截断后常产生两类孤儿：
 *   - 有 tool 结果、无对应 tool_calls（translator 会把"剩余"的 tool_result 也推出去）
 *   - 有 tool_calls、无对应 tool 结果（assistant 之后未能得到回填）
 * 孤儿会导致下一轮请求被上游以 400 拒绝。
 *
 * 纯函数，便于离线单测。仅在 CodeBuddy 出站前调用，**不触碰三后端共享的字节稳定器**。
 * @module services/codebuddy/tool-pairing
 */

/** 孤儿 tool_calls 的占位结果内容（中性纯文本，避免 sortJsonString 参与、避免模型误判为失败重试） */
const PLACEHOLDER_CONTENT = 'Tool call was not executed.';

/**
 * 清理孤儿工具消息
 *
 * (A) 丢弃无对应 `assistant.tool_calls` 的 `role:'tool'` 消息
 * (B) 无对应 tool 结果的 `tool_calls` 不删除（删除会改变 assistant 语义），
 *     而是在其后插入一条中性占位 tool 消息
 *
 * 幂等：清理后的结果再次清理应返回 changed=false。
 * 无改动时返回**同一数组引用**，保证零字节差异（不影响 prompt 前缀缓存）。
 *
 * @param {Array} messages - OpenAI 格式消息数组
 * @returns {{messages: Array, changed: boolean, droppedToolMessages: number, placeholders: number}}
 */
export function pruneOrphanToolMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return {messages, changed: false, droppedToolMessages: 0, placeholders: 0};
    }

    // 第一遍：收集已声明的 tool_call id 与已回答的 tool_call_id
    const declaredIds = new Set();
    for (const msg of messages) {
        if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                if (tc && tc.id) declaredIds.add(tc.id);
            }
        }
    }

    let droppedToolMessages = 0;
    let placeholders = 0;

    // 第二遍：丢弃孤儿 tool 消息（A），并记录每个 id 是否已被回答
    const answeredIds = new Set();
    const kept = [];
    for (const msg of messages) {
        if (msg && msg.role === 'tool') {
            const id = msg.tool_call_id;
            if (!id || !declaredIds.has(id)) {
                droppedToolMessages++;
                continue;
            }
            answeredIds.add(id);
            kept.push(msg);
        } else {
            kept.push(msg);
        }
    }

    // 第三遍：为未被回答的 tool_calls 补占位（B）
    // 占位插入在该 assistant 之后的**连续 tool 消息组末尾**，保证同批 tool 结果聚在一起
    const out = [];
    for (let i = 0; i < kept.length; i++) {
        const msg = kept[i];
        out.push(msg);

        if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            // 先把紧随其后的连续 tool 消息原样输出
            let j = i + 1;
            while (j < kept.length && kept[j] && kept[j].role === 'tool') {
                out.push(kept[j]);
                j++;
            }
            // 再为未被回答的 tool_calls 补占位
            for (const tc of msg.tool_calls) {
                if (tc && tc.id && !answeredIds.has(tc.id)) {
                    out.push({role: 'tool', tool_call_id: tc.id, content: PLACEHOLDER_CONTENT});
                    answeredIds.add(tc.id);
                    placeholders++;
                }
            }
            // 跳过已输出的 tool 消息
            i = j - 1;
        }
    }

    const changed = droppedToolMessages > 0 || placeholders > 0;
    // 无改动时返回原引用，保证零字节差异
    return {messages: changed ? out : messages, changed, droppedToolMessages, placeholders};
}
