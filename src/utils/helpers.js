import { randomBytes } from 'crypto';

/**
 * 通用辅助函数模块
 * @module utils/helpers
 */

/**
 * 生成随机 ID，支持可选前缀以兼容 Claude 格式
 * @param {string} [prefix] - 可选前缀（如 'msg', 'toolu'）
 * @returns {string} 随机字符串 ID
 */
export function generateId(prefix) {
    const id = randomBytes(16).toString('hex');
    return prefix ? `${prefix}_${id}` : id;
}

/**
 * 构建完整 URL
 * @param {string} baseUrl - 基础 URL
 * @param {string} endpoint - 端点路径
 * @returns {string} 完整 URL
 */
export function buildUrl(baseUrl, endpoint) {
    let finalUrl = baseUrl;
    let finalEndpoint = endpoint;

    if (finalEndpoint.startsWith('/')) {
        finalEndpoint = finalEndpoint.slice(1);
    }

    if (!finalUrl.endsWith('/')) {
        finalUrl += '/';
    }

    // 去重：base_url 已含 /vN，endpoint 又带了 /vM，保留 base_url 的版本号
    // e.g. /api/v3/v1/chat → /api/v3/chat, /v1/v1/chat → /v1/chat
    // 循环处理直到不再有重复，以覆盖 /v1/v1/v1/... 等多层重复
    let url = finalUrl + finalEndpoint;
    let prev;
    do {
        prev = url;
        url = url.replace(/\/(v\d+)\/v\d+\//g, '/$1/');
    } while (url !== prev);
    return url;
}

/**
 * 清理 JSON Schema，移除不兼容的属性
 * 只删除 $schema（JSON Schema 版本声明，LLM API 不需要）
 * 保留 additionalProperties（约束参数结构，帮助模型区分工具）
 * 保留 format（提供参数语义，如路径 vs 命令）
 * 保留 title 和 examples（静态内容，不影响缓存，帮助模型理解参数）
 * @param {object} schema - JSON Schema 对象
 * @returns {object} 清理后的 Schema
 */
export function cleanJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const needsCleanup = Object.keys(schema).some(key => key === '$schema');

    // 如果没有需要清理的属性，直接递归处理子对象
    if (!needsCleanup) {
        let hasChanges = false;
        const result = {...schema};

        for (const key in result) {
            if (key === 'properties' && typeof result[key] === 'object') {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            } else if (key === 'items' && typeof result[key] === 'object') {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            } else if (typeof result[key] === 'object' && !Array.isArray(result[key])) {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            }
        }

        return hasChanges ? result : schema;
    }

    // 需要删除属性，创建新对象
    const cleaned = {};

    for (const key in schema) {
        if (key === '$schema') {
            continue;
        }

        if (key === 'enum' && Array.isArray(schema[key])) {
            cleaned[key] = schema[key];
        } else if (key === 'properties' && typeof schema[key] === 'object') {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else if (key === 'items' && typeof schema[key] === 'object') {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else if (typeof schema[key] === 'object' && !Array.isArray(schema[key])) {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else {
            cleaned[key] = schema[key];
        }
    }

    return cleaned;
}

/**
 * 把时长毫秒数格式化为可读字符串
 * 用于展示 429 冷却剩余时间等场景
 * @param {number} ms - 时长（毫秒）
 * @returns {string} 如 '59s' / '4m30s' / '2h5m'；ms<=0 或非法时返回 '0s'
 */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
    if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
    return `${s}s`;
}
