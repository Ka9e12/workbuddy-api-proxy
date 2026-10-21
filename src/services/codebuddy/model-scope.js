/**
 * 按 API Key 作用域挑选模型查询账号，并合并多站点模型列表
 *
 * 为什么单独成模块：这段逻辑是「Key 权限」与「模型列表」的交点，
 * 也是最容易越权的地方 —— 一旦误用按站点挑代表的 `pickCredentialPerRealm`，
 * 受限 Key 就会看到未勾选站点的模型。抽出来才好在测试里直接盯住。
 *
 * @module services/codebuddy/model-scope
 */

import {BLOCKED_DOMAINS, getCodebuddyBaseUrl} from './config.js';

/**
 * 把客户端请求的模型名映射成真正发给上游的名字
 *
 * 主要是处理 Codex 兼容：它默认发 gpt-* / codex，而 CodeBuddy 上游没有这些名字，
 * 统一改写成国产模型。注意这件事对「模型权限」判断很关键——
 * 上游看不到 gpt-5.5，也就不会因为它没权限而报错，所以
 * 判断权限时必须用映射后的名字，否则会把能用的模型误过滤掉。
 *
 * @param {string} model
 * @returns {string}
 */
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
 * 归一作用域为 Set
 * @param {null|undefined|string[]} allowedFilenames
 * @returns {Set<string>|null} null 表示不限
 */
function toAllowedSet(allowedFilenames) {
    if (allowedFilenames === null || allowedFilenames === undefined) return null;
    if (!Array.isArray(allowedFilenames)) return null;
    return new Set(allowedFilenames.map(String));
}

/**
 * 按上游 baseUrl 分组，每组挑一个代表账号
 *
 * 分组键必须是 baseUrl，不能是 realm：`realmKeyOf` 只有 cn/intl 二值，
 * 企业站会落进 cn，表达不了「这个 Key 只勾了某一个具体账号」。
 *
 * 代表优先级：可用（未禁用/未过期/未冷却）> 冷却中但仍未禁用未过期。
 * 拉模型是只读查询、不占上游用量，所以冷却中的号也能用来查。
 *
 * 已禁用、已过期、域名废弃的账号不参与——它们本来也调不通。
 *
 * @param {Object} tm - TenantTokenManager 实例
 * @param {null|string[]} allowedFilenames - null 表示不限
 * @returns {Array<{baseUrl: string, account: string, credential: Object}>}
 */
export function pickScopedModelTargets(tm, allowedFilenames) {
    if (!tm || !Array.isArray(tm.credentials)) return [];
    const allowedSet = toAllowedSet(allowedFilenames);
    /** @type {Map<string, {baseUrl: string, account: string, credential: Object, rank: number}>} */
    const groups = new Map();

    for (let i = 0; i < tm.credentials.length; i++) {
        const entry = tm.credentials[i];
        const data = entry?.data;
        if (!data || !data.bearer_token) continue;

        const filename = String(entry.filePath || '').split(/[\\/]/).pop();
        if (allowedSet !== null && !allowedSet.has(filename)) continue;
        if (Array.isArray(tm.disabledIndexes) && tm.disabledIndexes.includes(i)) continue;
        if (typeof tm.isTokenExpired === 'function' && tm.isTokenExpired(data)) continue;

        const baseUrl = getCodebuddyBaseUrl(data.base_url);
        try {
            if (BLOCKED_DOMAINS.includes(new URL(baseUrl).host)) continue;
        } catch {
            // baseUrl 形态异常交给下游报错，这里不拦
        }

        // 按「站点 + 账号」分组而不是只按站点：
        // 模型权限是按账号记录的（免费号能看见 gpt 但调不了），
        // 只取站点代表会把「A 号没权限」误算成「B 号也没权限」。
        // 同一账号在数组里只出现一次，用文件名做键。
        const key = `${baseUrl}\u0000${filename}`;
        if (groups.has(key)) continue;

        // rank 越小越好：0 = 完全可用，1 = 冷却中但可读
        const rank = typeof tm.isRateLimited === 'function' && tm.isRateLimited(i) ? 1 : 0;
        groups.set(key, {baseUrl, account: filename, credential: data, rank});
    }

    // 完全可用的账号排前面，让后续「先问谁」的顺序稳定
    return Array.from(groups.values())
        .sort((a, b) => a.rank - b.rank || a.baseUrl.localeCompare(b.baseUrl) || a.account.localeCompare(b.account))
        .map(({baseUrl, account, credential}) => ({baseUrl, account, credential}));
}

/**
 * 合并多个站点的模型列表，按 id 去重
 *
 * 去重保留首个出现的条目：同名模型在国内站和国际站可能标价不同，
 * 但客户端只认 id，重复列出会让模型选择器出现两行一样的名字。
 *
 * @param {Array<{status: 'fulfilled'|'rejected', value?: {models: Array}, reason?: any}>} outcomes
 * @returns {Array<{id: string, name: string, vendor: string}>}
 */
export function mergeModelResults(outcomes = []) {
    const merged = [];
    const seen = new Set();
    for (const outcome of outcomes) {
        if (!outcome || outcome.status !== 'fulfilled') continue;
        const models = Array.isArray(outcome.value?.models) ? outcome.value.models : [];
        for (const model of models) {
            if (!model || typeof model.id !== 'string' || !model.id) continue;
            if (seen.has(model.id)) continue;
            seen.add(model.id);
            merged.push({
                id: model.id,
                name: model.name || model.id,
                vendor: model.vendor || 'codebuddy'
            });
        }
    }
    return merged;
}
