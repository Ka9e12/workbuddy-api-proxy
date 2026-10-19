/**
 * Transformer 注册模块
 * 参考 claude-code-router 架构
 */

import { ClaudeToOpenAITransformer } from './claude-to-openai.js';

// 导出所有 Transformer 类（用于 TransformerService）
export default {
    ClaudeToOpenAITransformer
};

// 保持向后兼容的映射表
const transformerInstances = {
    openai: new ClaudeToOpenAITransformer()
};

/**
 * 根据类型获取对应的 Transformer 实例（向后兼容）
 * @param {string} type - Provider 类型（如 'openai'）
 * @returns {import('./claude-to-openai.js').ClaudeToOpenAITransformer | null}
 */
export function getTransformer(type) {
    return transformerInstances[type] || null;
}

/**
 * 获取所有可用的 Transformer 类型（向后兼容）
 * @returns {string[]}
 */
export function getAvailableTransformers() {
    return Object.keys(transformerInstances);
}

// 导出 Transformer 服务相关函数
/**
 * 获取所有 Transformer 类（用于 TransformerService）
 * @returns {Object} Transformer 类映射表
 */
export function getTransformerClasses() {
    return {
        ClaudeToOpenAITransformer
    };
}