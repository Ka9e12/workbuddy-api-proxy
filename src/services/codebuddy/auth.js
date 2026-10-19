/**
 * CodeBuddy 凭证管理
 * @module services/codebuddy/auth
 */

import {credentialStore} from './credential-store.js';
import {isUpstreamBusyCode, isWafBlockCode} from './api.js';
import logger from '../../utils/logger.js';

/**
 * 获取下一个可用凭证
 * @param {Object} [opts]
 * @param {string} [opts.sessionKey] - 会话键（用于粘性绑定）
 * @param {string} [opts.model] - 当前请求模型（用于模型级冷却判定）
 * @returns {Object|null} 凭证数据或 null
 */
export function getCredential(opts) {
    return credentialStore.getNextCredential(opts);
}

/**
 * 只读获取一个当前可用凭证（不推进轮换计数、不绑定会话）
 * 用于模型列表等非聊天查询
 * @returns {Object|null}
 */
export function peekCredential() {
    return credentialStore.peekCredential();
}

/**
 * 按凭证数据对象查索引（供路由层精确归因冷却）
 * @param {Object} credentialData
 * @returns {number} 索引，未找到返回 -1
 */
export function indexOfCredential(credentialData) {
    return credentialStore.getTokenManager().indexOfCredential(credentialData);
}

/**
 * 记录一次上游成功（清零连续失败/软冷却计数）
 * @param {number} index
 */
export function noteUpstreamSuccess(index) {
    if (index >= 0) credentialStore.getTokenManager().noteSuccess(index);
}

/**
 * 记录一次上游失败并施加分级冷却
 * @param {Object} error - 上游错误（CodeBuddyApiError）
 * @param {number} credIndex - 本次请求实际使用的凭证索引
 * @param {string} [model] - 当前请求模型
 */
export function noteUpstreamFailure(error, credIndex, model) {
    if (!Number.isInteger(credIndex) || credIndex < 0) return;
    const tm = credentialStore.getTokenManager();
    const status = error?.status;
    const code = error?.code;

    // 渠道排队（code 6021）：推理集群打满，换任何账号都撞同一堵墙。
    // 绝不能按 429 冷却账号 —— 那会在几秒内把整池健康号标成不可用，
    // 而它们十分钟后本来就会自己恢复。这里一个动作都不做。
    if (isUpstreamBusyCode(code)) {
        logger.warn(`[CodeBuddy] 上游排队已满（code 6021），不冷却账号 #${credIndex}`);
        return;
    }
    // WAF 拦截（code 11128）：账号本身没问题，是请求被渠道校验拒了，
    // 通常因为短时间内请求过密。同样不按账号故障处理。
    if (isWafBlockCode(code)) {
        logger.warn(`[CodeBuddy] 上游渠道校验拦截（code 11128），不冷却账号 #${credIndex}`);
        return;
    }

    // 模型级限流（code 6004）：只冷却该模型，不改账号级冷却，切模型即可用
    if (code === 6004 || code === '6004') {
        tm.markModelCooldown(credIndex, model, tm.constructor.MODEL_COOLDOWN);
        return;
    }
    if (status === 402) {
        // 余额不足：硬冷却到次日 04:00
        tm.markRateLimited(credIndex, tm.constructor.untilNext4AM(), 'balance');
        return;
    }
    if (status === 404) {
        tm.markRateLimited(credIndex, tm.constructor.NOT_FOUND_COOLDOWN, 'not_found');
        return;
    }
    if (status === 429) {
        // 429 普通软冷却：指数退避（独立于熔断计数）
        // 若本次选号走的是全池兜底路径，则不推进连续计数（避免重试把账号越推越冷）
        const fromFallback = tm.lastPickWasFallback === true;
        tm.noteSoftRateLimit(credIndex, {fromFallback});
        return;
    }
    if (status >= 500) {
        // 连续 5xx：达阈值熔断（带时间窗口，散点失败不误熔断）
        tm.noteFailure(credIndex);
        return;
    }
    // 其余 4xx（含 400 内容拦截 / 请求体问题）：不罚账号
}

/**
 * 记录一次流式请求的终态，按终态决定是否入账/惩罚账号
 *
 * 与 noteUpstreamFailure 的分工：
 * - 流错误帧若带 status/code，调用方应直接走 noteUpstreamFailure（复用 402/404/429/5xx 分级），
 *   不要走这里的 'upstream' 分支（那只会按 5xx 语义记熔断）。
 * - 本函数用于：流正常结束（success）、网络中断（network）、无 status 的 error 帧（upstream）、
 *   空流（empty）、客户端断开（client-abort）。
 *
 * @param {number} index
 * @param {string} outcome - classifyStreamOutcome 的结果
 * @param {Object} [meta]
 * @param {string} [meta.sessionKey] - 会话键（network 终态时解绑粘性，避免下次仍钉在坏号上）
 * @param {Object} [meta.errorFrame] - 流内 error 帧（可能带 status/code）；带 6021/11128 时不罚账号
 */
export function noteStreamOutcome(index, outcome, meta = {}) {
    if (!Number.isInteger(index) || index < 0) return;
    const tm = credentialStore.getTokenManager();

    // 流内 error 帧若带渠道级错误码，先短路：这不是账号的问题。
    // 调用方对"带 status/code 的错误帧"通常直接走 noteUpstreamFailure，
    // 这里是兜底，避免某条路径漏判后仍按 5xx 记熔断。
    const frameCode = meta.errorFrame?.code;
    if (isUpstreamBusyCode(frameCode) || isWafBlockCode(frameCode)) {
        logger.warn(`[CodeBuddy] 流内错误帧 code ${frameCode}（渠道级），不罚账号 #${index}`);
        return;
    }

    switch (outcome) {
        case 'success':
            tm.noteSuccess(index);
            break;
        case 'upstream':
            // 上游业务失败但未带 status：按 5xx 语义记熔断计数（带时间窗口）
            tm.noteFailure(index);
            break;
        case 'network':
            // 网络/链路问题：不罚账号（不是账号的错），但解绑会话粘性，
            // 让下一次请求重新选号、自然分散到其它账号
            if (meta.sessionKey) tm.unbindSession(meta.sessionKey);
            break;
        case 'client-abort':
        case 'empty':
        default:
            // 不罚账号：客户端断开与空流都属含混，宁可放过
            break;
    }
}

/**
 * 标记上次使用的凭证为 429 限速
 * @param {number} [durationMs] - 限速持续时间（毫秒）
 */
export function markLastReturnedRateLimited(durationMs) {
    credentialStore.markLastReturnedRateLimited(durationMs);
}

/**
 * 获取上次返回的凭证索引
 * @returns {number|null}
 */
export function getLastReturnedIndex() {
    return credentialStore.getLastReturnedIndex();
}
