/**
 * 同请求内换号（failover）的判定
 *
 * 为什么需要：网关原本是「选一个号 → 打一次上游 → 失败就把错误返回给客户端」，
 * 换号只发生在客户端下一次请求时。而客户端拿到 502 后的重试间隔是 0.5s / 1s 级别，
 * 但每次尝试都要重新等一遍上游超时（首字节默认 120s），于是用户感知到的是
 * 「卡好几分钟，中间没有任何提示」。给它一次同请求内的换号机会，能把这段
 * 等待压缩成「一次超时 + 一次成功」。
 *
 * 安全边界：调用方只在 `writeHead(200)` 之前换号，此时客户端一个字节都没收到，
 * 换号对客户端完全透明。一旦开流就不能换，否则会把两条流拼在一起。
 *
 * 纯函数、无 IO，便于离线单测。
 * @module services/codebuddy/failover
 */

import {isNetworkError} from '../../utils/http-client.js';
import {isUpstreamBusyCode, isWafBlockCode} from './api.js';

/** 默认最多尝试几次（含首次）。2 = 首次失败后给一次换号机会 */
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * 该错误是否值得换一个账号重试
 *
 * 判断依据是「换个账号有没有可能成功」：
 * - 网络/超时：可能是这个上游的问题，换站点有意义
 * - 5xx：同上
 * - 429 / 402 / 404：账号级状态，换号直接有效
 * - 6021（集群排队）/ 11128（WAF 拦截）：同站点换号没用，但**跨站点**有用
 *   —— 国际站的 WAF 拦不到国内站。调用方应配合 preferDifferentSite 使用。
 *
 * 不值得换的：
 * - 400 请求体不合法：换谁都是同一个错
 * - 6004 / 11102 模型级不可用：是该模型的问题，换号无效
 *
 * @param {Error} error
 * @returns {boolean}
 */
export function shouldFailover(error) {
    if (!error) return false;

    // 网络/链路层错误：http-client 抛出的 UpstreamNetworkError 全系列
    if (isNetworkError(error)) return true;

    const status = Number(error.status);
    const code = error.code;

    // 模型级不可用：换号无效（换模型才有用）
    if (code === 6004 || code === '6004' || code === 11102 || code === '11102') return false;

    // 渠道级问题：同站点换号无效，但调用方会优先挑别的站点，所以仍允许换一次
    if (isUpstreamBusyCode(code) || isWafBlockCode(code)) return true;

    // 请求体不合法：不是账号的问题
    if (status === 400) return false;

    // 账号级问题：换号直接有效
    if (status === 429 || status === 402 || status === 404) return true;

    // 上游 5xx
    if (Number.isFinite(status) && status >= 500) return true;

    // 其它 4xx：请求本身有问题，换号没用
    if (Number.isFinite(status) && status >= 400) return false;

    // 认不出的错误（有 status 之外的异常）：保守起见换一次
    return true;
}

/**
 * 计算本次请求最多尝试几次
 *
 * 只有池子里还有别的可用号时才值得重试 —— 单号池换号换不出新结果，
 * 只是把同一份失败再付一次超时代价。
 *
 * @param {number} availableCount - 作用域内可用账号数
 * @param {number} [configured] - 配置的上限（环境变量）
 * @returns {number} 实际尝试次数上限（含首次），最小 1
 */
export function resolveMaxAttempts(availableCount, configured = DEFAULT_MAX_ATTEMPTS) {
    const cap = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_ATTEMPTS;
    if (!Number.isFinite(availableCount) || availableCount <= 1) return 1;
    return Math.min(cap, availableCount);
}
