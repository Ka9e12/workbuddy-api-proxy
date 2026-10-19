/**
 * CodeBuddy 配置
 * @module services/codebuddy/config
 */

import {readFileSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';

export const DEFAULT_BASE_URL = 'https://copilot.tencent.com';

// 禁止使用的上游域名（这些域名已废弃，不可再添加新凭证）
export const BLOCKED_DOMAINS = ['dhcode2025.copilot.qq.com'];

/**
 * 获取 CodeBuddy 基础 URL
 * @param {string} [baseUrl] - 可选，优先使用传入值
 * @returns {string}
 */
export function getCodebuddyBaseUrl(baseUrl) {
    if (baseUrl) return baseUrl;
    return DEFAULT_BASE_URL;
}

// 凭证目录
export const CODEBUDDY_CREDS_DIR = process.env.CODEBUDDY_CREDS_DIR || '.codebuddy';

const DOMESTIC_MODELS = [
    {id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', vendor: 'zhipu'},
    {id: 'glm-5.3', name: 'GLM-5.3', vendor: 'zhipu'},
    {id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', vendor: 'zhipu'},
    {id: 'glm-5.2', name: 'GLM-5.2', vendor: 'zhipu'},
    {id: 'glm-5.1', name: 'GLM-5.1', vendor: 'zhipu'},
    {id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', vendor: 'zhipu'},
    {id: 'glm-4.6', name: 'GLM-4.6', vendor: 'zhipu'},
    {id: 'minimax-m2.7', name: 'MiniMax-M2.7', vendor: 'minimax'},
    {id: 'minimax-m3', name: 'MiniMax-M3', vendor: 'minimax'},
    {id: 'kimi-k3-1', name: 'Kimi-K3', vendor: 'moonshot'},
    {id: 'kimi-k2.6', name: 'Kimi-K2.6', vendor: 'moonshot'},
    {id: 'kimi-k2.5', name: 'Kimi-K2.5', vendor: 'moonshot'},
    {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', vendor: 'deepseek'},
    {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vendor: 'deepseek'},
    {id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', vendor: 'deepseek'},
    {id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', vendor: 'deepseek'}
];

const INTERNATIONAL_MODELS = [
    {id: 'glm-5.0', name: 'GLM-5.0', vendor: 'zhipu'},
    {id: 'kimi-k2.5', name: 'Kimi-K2.5', vendor: 'moonshot'},
    {id: 'gpt-5.5', name: 'GPT-5.5', vendor: 'openai'},
    {id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'openai'},
    {id: 'gpt-5.3-codex', name: 'GPT-5.3-codex', vendor: 'openai'},
    {id: 'gemini-3.5-flash', name: 'Gemini-3.5-flash', vendor: 'google'},
    {id: 'gemini-3.0-pro', name: 'Gemini-3.0-pro', vendor: 'google'},
    {id: 'gemini-3.0-flash', name: 'Gemini-3.0-flash', vendor: 'google'},
    {id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', vendor: 'deepseek'}
];

const ENTERPRISE_MODELS = [
    {id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', vendor: 'zhipu'},
    {id: 'glm-5.3', name: 'GLM-5.3', vendor: 'zhipu'},
    {id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', vendor: 'zhipu'},
    {id: 'glm-5.2', name: 'GLM-5.2', vendor: 'zhipu'},
    {id: 'glm-5.1', name: 'GLM-5.1', vendor: 'zhipu'},
    {id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', vendor: 'zhipu'},
    {id: 'glm-4.7', name: 'GLM-4.7', vendor: 'zhipu'},
    {id: 'minimax-m2.7', name: 'MiniMax-M2.7', vendor: 'minimax'},
    {id: 'minimax-m3', name: 'MiniMax-M3', vendor: 'minimax'},
    {id: 'kimi-k3-1', name: 'Kimi-K3', vendor: 'moonshot'},
    {id: 'kimi-k2.6', name: 'Kimi-K2.6', vendor: 'moonshot'},
    {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', vendor: 'deepseek'},
    {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vendor: 'deepseek'},
    {id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', vendor: 'deepseek'},
    {id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', vendor: 'deepseek'}
];

// 个人版官方域名 — 这些域名不需要传企业头
const PERSONAL_HOSTS = ['copilot.tencent.com', 'www.codebuddy.ai'];

/**
 * 根据模型 id 将模型归类到统一的厂商名（用于 owned_by / 前端分组）
 *
 * 上游 /v3/config 返回的 vendor 是单字母编码（f/e/j 等），对客户端不可读，
 * 这里按 id 前缀归一到可读厂商名，同厂模型聚合到一起：
 * - deepseek-*   -> deepseek
 * - glm-*        -> zhipu（智谱 GLM）
 * - kimi-*       -> moonshot（月之暗面 Kimi）
 * - minimax-*    -> minimax
 * - hy3/hy4/hunyuan-* -> hunyuan（腾讯混元，统一名）
 * - 其余（step-*、space-bunny 等）-> others
 *
 * @param {string} id - 模型 id
 * @param {string} [name] - 模型显示名（作为兜底启发式，暂未使用）
 * @returns {string} 归一化后的厂商名
 */
export function classifyModelVendor(id, name) {
    const lower = String(id || '').toLowerCase();
    if (lower.startsWith('deepseek-') || lower.startsWith('deepseek_')) return 'deepseek';
    if (lower.startsWith('glm-') || lower.startsWith('glm_')) return 'zhipu';
    if (lower.startsWith('kimi-') || lower.startsWith('kimi_')) return 'moonshot';
    if (lower.startsWith('minimax-') || lower.startsWith('minimax_')) return 'minimax';
    if (lower.startsWith('hy3') || lower.startsWith('hy4') || lower.startsWith('hunyuan-') || lower.startsWith('hunyuan_')) {
        return 'hunyuan';
    }
    return 'others';
}

export const CODEBUDDY_MODELS_BY_BASE_URL = {
    'https://copilot.tencent.com': DOMESTIC_MODELS,
    'https://www.codebuddy.ai': INTERNATIONAL_MODELS
};

/**
 * 从环境变量 CODEBUDDY_ENTERPRISE_HOSTS 解析企业站上游列表
 * 支持逗号分隔，可填写带协议的完整 URL（如 https://xxx.copilot.qq.com）
 * 或仅域名（自动补 https://），解析失败的项会被忽略并打 warn
 * @returns {string[]} 规范化后的 base_url 列表（已去重）
 */
function parseEnterpriseHostsEnv() {
    const raw = process.env.CODEBUDDY_ENTERPRISE_HOSTS;
    if (!raw) return [];
    const seen = new Set();
    const result = [];
    for (const item of raw.split(',')) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        try {
            const u = new URL(candidate);
            // 去掉 path/query，只保留 origin
            const normalized = `${u.protocol}//${u.host}`;
            if (!seen.has(normalized)) {
                seen.add(normalized);
                result.push(normalized);
            }
        } catch {
            logger.warn(`CODEBUDDY_ENTERPRISE_HOSTS 中无效的上游地址，已忽略: ${trimmed}`);
        }
    }
    return result;
}

const ENTERPRISE_HOSTS_FROM_ENV = parseEnterpriseHostsEnv();

// 把环境变量里的企业站合并到模型表（默认走 ENTERPRISE_MODELS 兜底，
// OAuth 成功后 hasEnterpriseIdentity 命中也仍会走 ENTERPRISE_MODELS）
for (const url of ENTERPRISE_HOSTS_FROM_ENV) {
    if (!CODEBUDDY_MODELS_BY_BASE_URL[url]) {
        CODEBUDDY_MODELS_BY_BASE_URL[url] = ENTERPRISE_MODELS;
    }
}

/**
 * 获取通过环境变量配置的企业站上游列表
 * @returns {string[]}
 */
export function getEnterpriseBaseUrls() {
    return [...ENTERPRISE_HOSTS_FROM_ENV];
}

export function getCodebuddyBaseUrlOptions() {
    return Object.keys(CODEBUDDY_MODELS_BY_BASE_URL);
}

export function hasEnterpriseIdentity(credential = {}) {
    return Boolean(credential.enterprise_id || credential.enterpriseId || credential.department_info || credential.departmentInfo);
}

export function getCodebuddyModels(credential = {}) {
    if (typeof credential === 'string') {
        return CODEBUDDY_MODELS_BY_BASE_URL[getCodebuddyBaseUrl(credential)] || DOMESTIC_MODELS;
    }
    if (hasEnterpriseIdentity(credential)) return ENTERPRISE_MODELS;
    return CODEBUDDY_MODELS_BY_BASE_URL[getCodebuddyBaseUrl(credential.base_url)] || DOMESTIC_MODELS;
}

/**
 * 判断上游域名是否为个人版
 * @param {string} host - 域名（不含端口和协议）
 * @returns {boolean} true = 个人版
 */
export function isPersonalHost(host) {
    return PERSONAL_HOSTS.includes(host);
}

/**
 * 规范化架构名称（与 CLI OpenAI SDK 逻辑一致）
 * x64 -> amd64, arm -> arm32, ppc -> ppc32
 */
function normalizeArch(arch) {
    if (arch === 'x64') return 'amd64';
    if (arch === 'arm') return 'arm32';
    if (arch === 'ppc') return 'ppc32';
    return arch;
}

/**
 * 规范化平台名称（与 CLI OpenAI SDK 逻辑一致）
 * win32 -> windows, sunos -> solaris
 */
function normalizePlatform(platform) {
    if (platform === 'win32') return 'windows';
    if (platform === 'sunos') return 'solaris';
    return platform;
}

/**
 * 检测运行时类型
 */
function detectRuntime() {
    if (typeof Deno !== 'undefined') return 'deno';
    if (typeof EdgeRuntime !== 'undefined') return 'edge';
    if (typeof process !== 'undefined' && process.release?.name === 'node') return 'node';
    return 'unknown';
}

// CodeBuddy CLI 版本号（用于 User-Agent 和 X-IDE-Version）
// 优先从环境变量读取，否则尝试从本地安装的 CodeBuddy CLI 获取
export const CODEBUDDY_CLI_VERSION = (() => {
    try {
        const pkg = JSON.parse(
            readFileSync(join(process.cwd(), 'node_modules/@tencent-ai/codebuddy-code/package.json'), 'utf8')
        );
        if (pkg.version) return pkg.version;
    } catch {
        /* ignore */
    }
    return '2.93.1';
})();

// OpenAI SDK 版本号（从 CodeBuddy CLI 依赖中读取）
const OPENAI_SDK_VERSION = (() => {
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/openai/package.json'), 'utf8'));
        if (pkg.version) return pkg.version;
    } catch {
        /* ignore */
    }
    return '6.25.0';
})();

/**
 * 生成 CodeBuddy 请求头
 * 根据上游域名自动区分个人版/企业版：
 * - 个人版（copilot.tencent.com / www.codebuddy.ai）：只传基础头，X-Product = "SaaS"
 * - 企业版（其他域名）：额外传 X-Enterprise-Id / X-Tenant-Id / X-Department-Info
 *
 * @param {string} bearerToken - Bearer token
 * @param {Object} options - 可选参数
 * @param {string} [options.baseUrl] - 上游基础 URL
 * @param {string} [options.userId] - 用户 ID
 * @param {string} [options.enterpriseId] - 企业 ID（企业版需要）
 * @param {string} [options.departmentInfo] - 部门全称（企业版需要）
 * @param {string} [options.domain] - 认证域（企业版需要）
 * @returns {Object} 请求头
 */
export function codebuddyHeaders(bearerToken, options = {}) {
    const {
        conversationId,
        conversationRequestId,
        conversationMessageId,
        requestId,
        userId = process.env.CODEBUDDY_DEFAULT_USER_ID || 'unknown',
        enterpriseId,
        departmentInfo,
        domain,
        baseUrl
    } = options;

    const resolvedBaseUrl = getCodebuddyBaseUrl(baseUrl);
    const host = new URL(resolvedBaseUrl).host;
    const personal = isPersonalHost(host);

    const headers = {
        Host: host,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'x-stainless-arch': normalizeArch(process.arch ?? 'unknown'),
        'x-stainless-lang': 'js',
        'x-stainless-os': normalizePlatform(process.platform ?? 'unknown'),
        'x-stainless-package-version': OPENAI_SDK_VERSION,
        'x-stainless-retry-count': '0',
        'x-stainless-runtime': detectRuntime(),
        'x-stainless-runtime-version': process.version ?? 'unknown',
        'X-Agent-Intent': 'craft',
        'X-IDE-Type': 'CLI',
        'X-IDE-Name': 'CLI',
        'X-IDE-Version': CODEBUDDY_CLI_VERSION,
        Authorization: `Bearer ${bearerToken}`,
        'X-Domain': domain || host,
        'User-Agent': `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
        'X-Product': 'SaaS',
        'X-User-Id': userId
    };

    // 企业版额外头部
    if (!personal) {
        if (enterpriseId) {
            headers['X-Enterprise-Id'] = enterpriseId;
            headers['X-Tenant-Id'] = enterpriseId;
        }
        if (departmentInfo) {
            headers['X-Department-Info'] = departmentInfo;
        }
    }

    if (conversationId) {
        headers['X-Conversation-ID'] = conversationId;
    }
    if (conversationRequestId) {
        headers['X-Conversation-Request-ID'] = conversationRequestId;
    }
    if (conversationMessageId) {
        headers['X-Conversation-Message-ID'] = conversationMessageId;
    }
    if (requestId) {
        headers['X-Request-ID'] = requestId;
    }

    return headers;
}

/**
 * 获取 CodeBuddy API URL
 * @param {string} [baseUrl] - 可选，优先使用传入值
 * @returns {string}
 */
export function getCodebuddyApiUrl(baseUrl) {
    const resolved = getCodebuddyBaseUrl(baseUrl);
    return `${resolved}/v2/chat/completions`;
}
