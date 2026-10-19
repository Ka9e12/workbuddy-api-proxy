/**
 * 流式请求终态分类
 *
 * 为什么需要它：把"账号成功/失败"的判定从"拿到 200 响应头"延后到"流真正结束"。
 * 上游存在"200 开流但流里是 error 帧"的真实形态（限流/审核），此时若在开流时就记成功，
 * 限流号会被当成健康号反复选中、会话粘性还会把会话焊死在它上面。
 *
 * 纯函数、无 IO，便于离线单测。
 * @module services/codebuddy/stream-outcome
 */

import {isNetworkError} from '../../utils/http-client.js';

/**
 * 归类一次流式请求的终态
 * 判定优先级（顺序即优先级）：
 *   1. client-abort —— 客户端主动断开（绝不计罚）
 *   2. network      —— 网络/链路问题（含上游流空闲超时，其错误类继承网络错误）
 *   3. upstream     —— 上游返回 error 帧，或流被非网络错误中断（限流/审核等业务失败）
 *   4. empty        —— 200 但一帧有效数据都没有（上游静默失败，含混，宁可放过）
 *   5. success
 * @param {Object} p
 * @param {Error|null} [p.error] - 流 'error' 事件带来的错误
 * @param {boolean} [p.aborted] - 客户端断开（res.destroyed / signal.aborted）
 * @param {boolean} [p.sawUpstreamErrorFrame] - SSE data 中解析出过 error 字段
 * @param {boolean} [p.receivedAnyDelta] - 是否收到过任何有效帧
 * @returns {'success'|'client-abort'|'network'|'upstream'|'empty'}
 */
export function classifyStreamOutcome({error = null, aborted = false, sawUpstreamErrorFrame = false, receivedAnyDelta = false} = {}) {
    if (aborted) return 'client-abort';
    if (error && isNetworkError(error)) return 'network';
    if (sawUpstreamErrorFrame) return 'upstream';
    if (error) return 'upstream';
    if (!receivedAnyDelta) return 'empty';
    return 'success';
}

/**
 * 该终态是否应对账号施加惩罚（熔断计数）
 * 只有真正的上游业务失败才罚；网络问题、客户端断开、空流都不罚。
 * @param {string} outcome - classifyStreamOutcome 的结果
 * @returns {boolean}
 */
export function shouldPenalizeCredential(outcome) {
    return outcome === 'upstream';
}
