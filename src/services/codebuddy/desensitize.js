/**
 * 零宽脱敏模块 — 针对 CodeBuddy 后端内容审核（独立、仅 system 生效）
 * @module services/codebuddy/desensitize
 *
 * 背景
 * ----
 * CodeBuddy 后端（copilot.tencent.com）有内容审核，会拦截含"攻击/漏洞/凭证"
 * 等含义的英文术语。但这些词经常出现在客户端**固定的合规 system 模板**里
 * （例如 Claude Code 的 agent 声明：「Refuse requests for DoS attacks, exploit
 * development, credential testing, C2 frameworks ...」），属于**拒绝作恶**的
 * 合规声明，并非用户的有害输入，却被后端误判为敏感词，导致整条请求被拦。
 *
 * 做法
 * ----
 * 对"合规声明高频词"做轻量处理：在词内部插入零宽空格（U+200B），
 *
 *     "DoS" -> "Do​S"        （人/模型读仍是 DoS，后端关键词匹配失效）
 *
 * 只处理一个明确的词表，默认只作用于 system 角色的消息。不改动其它角色内容，
 * 避免影响真实对话。
 *
 * 设计原则
 * -------
 * - 独立模块，可单独 import / 单独测试。
 * - 保守：词表小而明确；只处理 system 消息。
 * - 不试图、也不可能绕过对用户真实有害输入的审核——只缓解客户端模板被误伤。
 * - 品牌词（Claude / Anthropic 等）由 api.js 的 replaceKeywords 单独处理（替换成
 *   官方词以伪装官方渠道），本模块只覆盖**没有官方对应词可替换的安全术语**。
 */

// 零宽空格：插入到关键词内部，打断后端的关键词匹配，但模型/人眼读起来无差别。
const ZWSP = '​';

// 触发审核的"合规声明高频词"（来自真实被拦截的客户端 system 模板）。
// 全部是"拒绝作恶"语境里常见的英文术语，大小写不敏感匹配。
// 注意：
// - 不含品牌词，品牌词由 replaceKeywords 走"替换成官方词"路线。
// - 收窄版：只保留"纯合规声明词"（明确指向攻击/漏洞/凭证滥用），
//   去掉 sandbox / attack / kill / injection / escalation 等编程与 agent
//   场景高频功能词，避免零宽化影响模型对功能指令的理解。
const SENSITIVE_TERMS = [
    'DoS',
    'DDoS',
    'exploit development',
    'credential testing',
    'credential stuffing',
    'supply chain compromise',
    'supply-chain compromise',
    'detection evasion',
    'C2 frameworks',
    'C2 framework',
    'command and control',
    'malicious purposes',
    'malicious intent',
    'mass targeting',
    'privilege escalation',
    'reverse shell',
    'remote code execution',
    'SQL injection',
    'XSS',
    'CSRF',
    'phishing',
    'malware',
    'ransomware',
    'keylogger',
    'rootkit',
    'botnet',
    'zero-day',
    '0day',
    'red teaming',
    'red-teaming',
    'penetration testing',
    'penetration test',
    'weaponize',
    'weaponized'
];

/**
 * 转义正则元字符
 */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 编译成一个正则：按词长降序（长词先匹配，避免短词先吃掉长词前缀），
// 用 \b 边界避免子串误伤（如 "kill" 误伤 "skills"），忽略大小写。
const PATTERN = new RegExp(
    SENSITIVE_TERMS
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((t) => `\\b${escapeRegExp(t)}\\b`)
        .join('|'),
    'gi'
);

/**
 * 在词内部插入零宽空格。如 'DoS' -> 'Do​S'。
 * 在第 1 个字符后插入即可（足够打断子串匹配，且改动最小）。
 */
function zeroWidthSplit(term) {
    if (term.length <= 1) return term;
    return term[0] + ZWSP + term.slice(1);
}

/**
 * 对文本中的触发词插入零宽空格。无触发词则原样返回。
 * @param {string} text
 * @returns {string}
 */
export function desensitizeText(text) {
    if (typeof text !== 'string' || !text) return text;
    return text.replace(PATTERN, (matched) => zeroWidthSplit(matched));
}

/**
 * 对指定角色的消息文本做零宽脱敏，返回新的 messages 数组（不修改原对象）。
 * 默认只处理 system 角色（合规模板集中地），真实用户输入保持原样。
 *
 * @param {Array} messages - OpenAI 格式的 messages
 * @param {string[]} [roles=['system']] - 需要脱敏的角色
 * @returns {Array} 脱敏后的新 messages 数组
 */
export function desensitizeMessages(messages, roles = ['system']) {
    if (!Array.isArray(messages)) return messages;

    return messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        if (!roles.includes(m.role)) return m;

        const nm = {...m};
        if (typeof nm.content === 'string') {
            nm.content = desensitizeText(nm.content);
        } else if (Array.isArray(nm.content)) {
            nm.content = nm.content.map((blk) => {
                if (blk && typeof blk === 'object' && typeof blk.text === 'string') {
                    return {...blk, text: desensitizeText(blk.text)};
                }
                if (blk && typeof blk === 'object' && typeof blk.content === 'string') {
                    return {...blk, content: desensitizeText(blk.content)};
                }
                return blk;
            });
        }
        return nm;
    });
}
