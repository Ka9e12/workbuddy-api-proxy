/**
 * CodeBuddy 成长中心 —— 连登兑换、猫猫旅行、抽奖
 * @module services/codebuddy/growth
 *
 * 背景
 * ----
 * 成长中心接口挂在聊天上游 copilot.tencent.com 的 /activity/growth/* 下，
 * 与计费接口（www.codebuddy.cn）是不同域名。均为从客户端逆向得到的非公开接口。
 *
 * 设计原则
 * -------
 * - 独立模块，不影响聊天请求主链路；只读凭证，不参与凭证轮换。
 * - **每个写操作都有严格前置门控**（只有状态确实满足才提交），
 *   路径或语义若与上游不符，只会无害失败并记录，不会误操作。
 * - 写操作**不重试**（避免超时后重复提交）；只读查询可重试。
 * - 仅支持国内个人站（企业站无个人成长体系，上游一律 403/400，直接跳过）。
 *
 * 已知边界
 * -------
 * - 任务体系：**不做**。5 个成长任务（首次对话 / 技能安装 / 链接微信 / 召唤专家 /
 *   使用模板）由上游按账号行为判定，本模块查不到逐项状态、也没有提交端点
 *   （实测 tasks/claim 等均 404）。CLI 侧技能是纯本地文件、不上报，
 *   所以代理无法触发其中任何一项。面板也不再展示这个数字。
 * - 连登兑换 / 抽奖：仅在档位已解锁 / 有抽奖次数时才动作（前置门控）。
 * - 猫猫旅行：无猫→同意协议+领养；idle→派出；arrived→领奖。
 */

import logger from '../../utils/logger.js';
import {request, readBody} from '../../utils/http-client.js';
import {randomUUID} from 'crypto';
import {credentialStore} from './credential-store.js';

// 成长中心基址（与计费接口不同域）。可用环境变量覆盖以便测试。
const GROWTH_BASE = process.env.CODEBUDDY_GROWTH_BASE || 'https://copilot.tencent.com/activity/growth/';
// 超时（只读与写入都用较短超时，避免拖住主流程）
const GROWTH_TIMEOUT = 15000;
// 旅行目的地兜底 id（咖啡馆）。仅在 buddy/travel/config 查询失败时使用。
const DEFAULT_LOCATION_ID = 1;

/**
 * 判断是否为国内个人站凭证（成长中心仅国内个人版有）
 * 企业站（含 enterprise_id）与国际化站跳过
 */
function isDomesticPersonal(credential) {
    if (!credential || !credential.bearer_token) return false;
    if (credential.enterprise_id || credential.enterpriseId) return false;
    const domain = String(credential.domain || '').toLowerCase();
    const baseUrl = String(credential.base_url || '').toLowerCase();
    if (domain.includes('workbuddy.ai') || baseUrl.includes('workbuddy.ai')) return false;
    return (
        domain.includes('codebuddy.cn') ||
        domain.includes('copilot.tencent.com') ||
        baseUrl.includes('copilot.tencent.com')
    );
}

/**
 * 构造成长中心请求头（复用凭证字段）
 */
function growthHeaders(credential) {
    return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.bearer_token}`,
        'X-User-Id': credential.user_id || '',
        'X-Domain': credential.domain || 'copilot.tencent.com',
        'X-Product': 'SaaS',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'CLI/2.95.1'
    };
}

/**
 * 调用成长中心接口
 * @param {Object} credential
 * @param {string} path - 相对路径（如 'streak'）
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Object} [options.body] - 请求体（POST）
 * @param {boolean} [options.retryOnNetwork=false] - 网络错误是否重试（仅只读查询用）
 * @returns {Promise<Object>} data 字段
 */
async function callGrowth(credential, path, {method = 'GET', body, retryOnNetwork = false} = {}) {
    const url = GROWTH_BASE + path;
    const attempt = async () => {
        const resp = await request(url, {
            method,
            headers: growthHeaders(credential),
            ...(body ? {body: JSON.stringify(body)} : {}),
            timeout: GROWTH_TIMEOUT
        });
        const raw = await readBody(resp.body);
        let json;
        try {
            json = JSON.parse(raw);
        } catch {
            const err = new Error(`成长接口 ${path} 返回非 JSON`);
            err.status = resp.status;
            throw err;
        }
        if (resp.status !== 200 || (json && typeof json === 'object' && json.code !== undefined && json.code !== 0)) {
            const err = new Error(
                `成长接口 ${path} 返回 HTTP ${resp.status} code=${json?.code} msg=${json?.msg || ''}`
            );
            err.status = resp.status;
            err.code = json?.code;
            throw err;
        }
        return json.data;
    };

    if (!retryOnNetwork) return attempt();

    // 只读查询：网络错误退避重试 1 次
    try {
        return await attempt();
    } catch (err) {
        const isNet = !err.status;
        if (!isNet) throw err;
        await new Promise((r) => setTimeout(r, 2000));
        return attempt();
    }
}

/* ==================== 只读查询 ==================== */

/**
 * 查询连登状态与兑换档位
 * @returns {Promise<{days, nextTier, nextTierRemaining, makeupCards, tiers}>}
 */
export async function queryStreak(credential) {
    const data = await callGrowth(credential, 'streak', {retryOnNetwork: true});
    const redemption = data?.redemption_status || {};
    return {
        days: parseInt(data?.streak?.days || 0, 10),
        nextTier: data?.streak?.next_tier || null,
        nextTierRemaining: parseInt(data?.streak?.next_tier_remaining || 0, 10),
        makeupCards: parseInt(data?.makeup_cards?.balance || 0, 10),
        tiers: (redemption.tiers || []).map((t) => ({
            tier: t.tier,
            days: t.days,
            credit: t.credit,
            energy: t.energy,
            chances: t.chances,
            status: redemption[`tier_${t.tier}_status`] || 'locked'
        }))
    };
}

/**
 * 查询猫猫档案（是否有猫，由 buddy/info 判断）
 * @returns {Promise<{hasBuddy: boolean, name: string|null, rarity: string|null}>}
 */
export async function queryBuddyInfo(credential) {
    const data = await callGrowth(credential, 'buddy/info', {retryOnNetwork: true});
    const buddy = data?.buddy || null;
    return {
        hasBuddy: !!buddy,
        name: buddy?.name || null,
        rarity: buddy?.rarity || null
    };
}

/**
 * 查询猫猫旅行状态
 * @returns {Promise<{state, dailyLimitReached, recordId, rewardCredit, arriveAt}>}
 */
export async function queryTravelStatus(credential) {
    const data = await callGrowth(credential, 'buddy/travel/status', {retryOnNetwork: true});
    return {
        state: data?.state || 'unknown',
        dailyLimitReached: data?.daily_limit_reached === true,
        recordId: data?.record_id || 0,
        rewardCredit: data?.reward_credit || 0,
        arriveAt: data?.arrive_at || 0
    };
}

/**
 * 查询可派出旅行的目的地清单
 * @returns {Promise<Array<{id:number, code:string, name:string, durationHoursMin:number, durationHoursMax:number}>>}
 */
export async function queryTravelConfig(credential) {
    const data = await callGrowth(credential, 'buddy/travel/config', {retryOnNetwork: true});
    return (data?.locations || []).map((l) => ({
        id: l.id,
        code: l.code || '',
        name: l.name || '',
        durationHoursMin: l.duration_hours_min || 0,
        durationHoursMax: l.duration_hours_max || 0
    }));
}

/**
 * 从目的地清单里挑一个用于派出。各目的地收益/时长区间相同，取第一个即可。
 * 清单为空时回退到已知有效的 id=1（咖啡馆），避免因一次 config 查询失败而放弃派出。
 * @param {Array<{id:number}>} locations
 * @returns {number|null}
 */
export function pickLocationId(locations) {
    const first = Array.isArray(locations) ? locations.find((l) => l && l.id) : null;
    if (first) return Number(first.id);
    return null;
}

/**
 * 查抽奖次数
 */
export async function queryLotteryChances(credential) {
    const data = await callGrowth(credential, 'lottery/summary', {retryOnNetwork: true});
    return parseInt(data?.chances || 0, 10);
}

/**
 * 领养猫猫（仅确认无猫时才提交；同意协议幂等）
 * @returns {Promise<{action:string, message:string}>}
 */
export async function adoptBuddy(credential) {
    const info = await queryBuddyInfo(credential);
    if (info.hasBuddy) {
        return {action: 'skip', message: '已领养猫猫'};
    }
    try {
        // 上游要求显式同意标记；发空对象时协议可能未真正生效
        await callGrowth(credential, 'buddy/agreement', {method: 'POST', body: {agree: true}});
    } catch (err) {
        // 同意协议幂等，失败不阻断领养尝试
        logger.warn(`[CodeBuddy growth] 同意协议失败（继续尝试领养）: ${err.message}`);
    }
    await callGrowth(credential, 'buddy/first', {method: 'POST', body: {}});
    return {action: 'adopted', message: '已领养猫猫'};
}

/* ==================== 写操作前置门控（纯函数，便于测试） ==================== */

/**
 * 决定是否可以派猫旅行
 * @param {{hasBuddy: boolean}} buddyInfo
 * @param {{state: string, dailyLimitReached: boolean}} status
 * @returns {{action: 'skip'|'depart', message: string}}
 */
export function decideDepart(buddyInfo, status) {
    if (!buddyInfo?.hasBuddy) return {action: 'skip', message: '尚未领养猫猫'};
    if (status?.state === 'traveling') return {action: 'skip', message: '猫猫正在旅行中'};
    if (status?.state === 'arrived') return {action: 'skip', message: '猫猫已到站，请先领取奖励'};
    if (status?.dailyLimitReached) return {action: 'skip', message: '今日旅行名额已用完'};
    if (status?.state !== 'idle') return {action: 'skip', message: `当前状态 ${status?.state}，不可派出`};
    return {action: 'depart', message: '可派出'};
}

/**
 * 决定是否可以领取到站奖励
 * @param {{state: string, recordId: number}} status
 * @returns {{action: 'skip'|'claim', message: string}}
 */
export function decideClaim(status) {
    if (status?.state !== 'arrived') return {action: 'skip', message: '猫猫尚未到站'};
    if (!status?.recordId) return {action: 'skip', message: '缺少 record_id，跳过领取'};
    return {action: 'claim', message: '可领取'};
}

/**
 * 决定是否要执行连登兑换（档位状态为 unlocked/available 才兑换）
 * @param {Array<{tier: string, status: string}>} tiers
 * @returns {Array<{tier: string}>}
 */
export function decideRedeemable(tiers) {
    return (tiers || []).filter((t) => t.status === 'unlocked' || t.status === 'available');
}

/* ==================== 写操作（均有前置门控） ==================== */

/**
 * 派猫旅行（仅 state=idle 且今日未达上限时才提交）
 * @returns {Promise<{action:string, message:string, location?:string}>}
 */
export async function departBuddy(credential) {
    const info = await queryBuddyInfo(credential);
    const status = info.hasBuddy ? await queryTravelStatus(credential) : null;
    const decision = decideDepart(info, status);
    if (decision.action !== 'depart') {
        return decision;
    }

    // depart 必须带 location_id：空 body 会被上游判 400 "invalid request"。
    // 目的地清单在 buddy/travel/config；各地点收益区间相同，取第一个即可。
    let locationId = null;
    try {
        locationId = pickLocationId(await queryTravelConfig(credential));
    } catch (err) {
        // config 查询失败不该阻断派出：用实测可用的默认地点兜底
        logger.warn(`[CodeBuddy growth] 查询旅行目的地失败（用默认地点）: ${err.message}`);
    }
    if (!locationId) locationId = DEFAULT_LOCATION_ID;

    const data = await callGrowth(credential, 'buddy/travel/depart', {
        method: 'POST',
        body: {location_id: locationId}
    });
    const locationName = data?.location?.name;
    return {
        action: 'departed',
        message: locationName ? `猫猫已出发前往「${locationName}」` : '猫猫已派出旅行',
        ...(locationName ? {location: locationName} : {})
    };
}

/**
 * 领取到站奖励（仅 state=arrived 时才提交）
 * @returns {Promise<{action:string, message:string, credit:number}>}
 */
export async function claimTravelReward(credential) {
    const status = await queryTravelStatus(credential);
    const decision = decideClaim(status);
    if (decision.action !== 'claim') {
        return {...decision, credit: 0};
    }

    await callGrowth(credential, 'buddy/travel/claim', {
        method: 'POST',
        body: {record_id: status.recordId}
    });
    return {action: 'claimed', message: '已领取到站奖励', credit: status.rewardCredit};
}

/**
 * 连登管家：兑换已解锁档位 + 抽完抽奖次数（幂等，均有前置门控）
 * @returns {Promise<{redeemed: Array, drawn: Array, message: string}>}
 */
export async function runStreakBonus(credential) {
    const redeemed = [];
    const drawn = [];

    // 1) 兑换已解锁（非 locked / 非 claimed）的档位
    const streak = await queryStreak(credential);
    for (const t of decideRedeemable(streak.tiers)) {
        try {
            await callGrowth(credential, 'redeem', {
                method: 'POST',
                body: {tier: t.tier, client_token: `u-${randomUUID()}`}
            });
            redeemed.push(t.tier);
            logger.info(`[CodeBuddy growth] 连登档位已兑换: ${t.tier}`);
        } catch (err) {
            logger.warn(`[CodeBuddy growth] 兑换档位 ${t.tier} 失败: ${err.message}`);
        }
    }

    // 2) 抽完抽奖次数（兑换后可能新增次数）
    let chances = await queryLotteryChances(credential);
    let guard = 0;
    while (chances > 0 && guard < 20) {
        guard++;
        try {
            await callGrowth(credential, 'lottery/draw', {
                method: 'POST',
                body: {client_token: `u-${randomUUID()}`}
            });
            drawn.push(true);
        } catch (err) {
            logger.warn(`[CodeBuddy growth] 抽奖失败: ${err.message}`);
            break;
        }
        chances = await queryLotteryChances(credential);
    }

    const parts = [];
    if (redeemed.length) parts.push(`兑换 ${redeemed.join('/')}`);
    if (drawn.length) parts.push(`抽奖 ${drawn.length} 次`);
    return {
        redeemed,
        drawn,
        message: parts.length ? parts.join('，') : '无可兑换档位或无抽奖次数'
    };
}

/* ==================== 组合任务 ==================== */

/**
 * 执行一次成长中心日常（供启动/手动触发）：
 * 领到站奖励 → 派出 → 连登管家
 * 幂等：每个动作先查状态再决定；写操作不重试。
 * @param {Object} credential
 * @returns {Promise<Object>} 各步结果
 */
export async function runGrowthDaily(credential) {
    if (!isDomesticPersonal(credential)) {
        return {skipped: true, reason: '企业站/国际站无个人成长体系'};
    }
    const result = {userId: credential.user_id || 'unknown'};

    try {
        // 无猫时先领养（前置门控：buddy/info 确认无猫才提交）
        const info = await queryBuddyInfo(credential);
        if (!info.hasBuddy) {
            result.adopt = await adoptBuddy(credential);
        }
    } catch (err) {
        result.adopt = {action: 'error', message: err.message};
    }

    try {
        result.claim = await claimTravelReward(credential);
    } catch (err) {
        result.claim = {action: 'error', message: err.message};
    }

    try {
        result.depart = await departBuddy(credential);
    } catch (err) {
        // 派出失败通常是上游契约变化（如 body 结构要求变了）。默认自动化每次启动都会跑，
        // 这里降为 warn 避免刷 error；该失败不影响聊天主链路，也不惩罚账号。
        result.depart = {action: 'error', message: err.message};
        logger.warn(`[CodeBuddy growth] 派猫失败（不影响聊天）：${err.message}`);
    }

    try {
        result.streak = await runStreakBonus(credential);
    } catch (err) {
        result.streak = {message: err.message};
    }

    return result;
}

/**
 * 查询某账号的成长中心概览（供管理面板展示，全部只读）
 *
 * 只查面板真正显示的两项：猫猫旅行状态。其余（连登、抽奖次数、成长任务、
 * 猫猫档案）前端都不消费，多查一次就是白打一次上游请求，所以不查。
 *
 * @returns {Promise<Object>}
 */
export async function queryGrowthOverview(credential) {
    if (!isDomesticPersonal(credential)) {
        return {
            supported: false,
            userId: credential?.user_id || 'unknown',
            reason: '企业站/国际站无个人成长体系'
        };
    }
    const out = {supported: true, userId: credential.user_id || 'unknown'};
    try {
        out.travel = await queryTravelStatus(credential);
    } catch (err) {
        out.travelError = err.message;
    }
    return out;
}

/**
 * 获取所有国内个人站凭证（供批量操作，不参与轮换）
 */
export function getGrowthCredentials() {
    const tm = credentialStore.getTokenManager();
    return tm.credentials
        .map((c) => c.data)
        .filter((c) => isDomesticPersonal(c));
}

/** 到站等待的上限（毫秒）：超过则不等，交由下次定时触发（避免占住计划任务实例） */
const ARRIVAL_WAIT_CAP = 5 * 60 * 1000;

/**
 * 纯函数：根据旅行状态决定是否需要"等到站后领奖"
 * 猫猫出去旅行会在 arriveAt 时间点回来，礼物需手动领取；若到站时间很近，
 * 可以就地等到站再领（避免礼物压到下一次触发）。
 * @param {Object} status - queryTravelStatus 的返回
 * @param {number} [now=Date.now()] - 当前时间戳（毫秒）
 * @returns {{shouldWait: boolean, waitMs: number, reason: string}}
 */
export function planArrivalWait(status, now = Date.now()) {
    if (!status || status.state !== 'traveling') {
        return {shouldWait: false, waitMs: 0, reason: 'not-traveling'};
    }
    const arriveAt = Number(status.arriveAt) || 0;
    // arriveAt 单位可能是秒或毫秒；统一归一到毫秒（< 10^12 视为秒）
    const arriveMs = arriveAt > 0 && arriveAt < 1e12 ? arriveAt * 1000 : arriveAt;
    if (!arriveMs || arriveMs <= now) {
        return {shouldWait: false, waitMs: 0, reason: 'no-arrival-time'};
    }
    const waitMs = arriveMs - now;
    if (waitMs > ARRIVAL_WAIT_CAP) {
        return {shouldWait: false, waitMs: 0, reason: 'beyond-cap'};
    }
    return {shouldWait: true, waitMs, reason: 'wait'};
}
