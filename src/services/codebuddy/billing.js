/**
 * CodeBuddy 积分余额查询与每日签到
 * 通过腾讯云计费接口查询账号剩余积分、查询/执行每日签到。
 * @module services/codebuddy/billing
 *
 * 背景
 * ----
 * CodeBuddy 个人版账号的积分与签到走腾讯云计费接口（www.codebuddy.cn），
 * 与聊天接口（copilot.tencent.com）是两套独立的后端。
 *
 * 设计原则
 * -------
 * - 独立模块，不影响聊天请求主链路；查询/签到只读凭证，不参与凭证轮换。
 * - 积分精确值优先取 Precise 字段（含小数），仅对"当前周期"（Cycle）额度求和。
 * - 签到幂等：以当日 checkin_date 持久化为准，避免重复签到；失败按冷却间隔重试。
 * - 仅支持国内站（domain 含 codebuddy.cn / copilot.tencent.com），国际站/企业站跳过。
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {request, readBody} from '../../utils/http-client.js';
import {credentialStore} from './credential-store.js';

// 计费接口路径（与聊天接口域名不同；国内站为 www.codebuddy.cn，国际站为 www.codebuddy.ai，
// 域名由 billingBaseFor 按账号所属区域解析，路径两边一致）
const BILLING_PATH = '/v2/billing/meter/';

// 签到状态持久化目录（放在 .codebuddy 下，与凭证同级）
const BILLING_STATE_DIR = '.codebuddy';
const BILLING_STATE_FILE = 'billing_state.json';

// 积分快照的"待刷新"阈值（毫秒）：10 分钟
const CREDITS_STALE_MS = 10 * 60 * 1000;

/**
 * 解析数值为非负 number；非法值按 0 处理
 */
function parseNumber(value) {
    if (typeof value === 'boolean') return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n;
}

/**
 * 从积分包列表汇总月度额度账本
 *
 * 口径按**包的自然月**切分，不是按"当前持有量"：
 * - 本月领取额度 = 本月创建的所有包面额之和
 * - 本月已花费   = 这些包里已经用掉的
 * - 本月剩余     = 这些包里还剩的
 * 三者天然闭环（领取 = 已花 + 剩余），且不受往月存量干扰。
 *
 * 为什么不按"发放后 30 天滚动"算：上游每个包的作废日是发放日 + 约 30 天，
 * 但月初领到的包会在次月作废、月末领到的拖到下下月，滚动口径会把两个月的
 * 账混在一起，既算不清"本月花了多少"，也没法跟签到记录对上。
 *
 * @param {Array} packages - get-user-resource 返回的 Accounts 数组
 * @param {Date} [now] - 用于确定"本月"，测试可注入
 * @returns {{month, monthLabel, remaining, capacity, used, packages, soonestExpiry, allTime}}
 */
export function summarizePackages(packages, now = new Date()) {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();

    let remain = 0;
    let size = 0;
    let used = 0;
    let liveCount = 0;
    let monthCount = 0;
    let soonestExpiry = null;
    let soonestTs = Infinity;

    // 全部口径（含往月）单独累计，供需要时对照
    let allCapacity = 0;
    let allRemaining = 0;
    let allUsed = 0;

    for (const p of packages) {
        // 当前周期额度用 Cycle 前缀字段，精确值优先
        const prefix = ('CycleCapacityRemainPrecise' in p || 'CycleCapacityRemain' in p) ? 'Cycle' : '';
        const field = (name, def) => {
            const precise = p[`${prefix}${name}Precise`];
            const plain = p[`${prefix}${name}`];
            if (precise !== undefined && precise !== null) return parseNumber(precise);
            if (plain !== undefined && plain !== null) return parseNumber(plain);
            return def;
        };
        const capacity = field('CapacitySize', 0);
        if (capacity <= 0) continue; // 非额度包，不参与账本
        const r = Math.min(field('CapacityRemain', capacity), capacity);
        const u = field('CapacityUsed', Math.max(0, capacity - r));

        allCapacity += capacity;
        allRemaining += r;
        allUsed += u;

        // 本月领取的包才进本月账本
        const createdAt = Number(p.CreateTime) || 0;
        const isThisMonth = createdAt >= monthStart && createdAt < monthEnd;
        if (isThisMonth) {
            monthCount++;
            remain += r;
            size += capacity;
            used += u;
        }

        // 最近作废：只看还有余额的包。往月的包也可能还有余额，
        // 它们同样是"会过期的钱"，所以这里不按月份过滤。
        if (r > 0) {
            liveCount++;
            const expiry = Number(p.DeductionEndTime) || 0;
            if (expiry > now.getTime() && expiry < soonestTs) {
                soonestTs = expiry;
                soonestExpiry = {
                    at: expiry,
                    daysLeft: (expiry - now.getTime()) / 86400000,
                    name: p.PackageName || '积分包',
                    remain: r
                };
            }
        }
    }

    return {
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        monthLabel: `${now.getMonth() + 1} 月`,
        // 本月口径（面板主展示）
        remaining: remain,
        capacity: size,
        used,
        packages: monthCount,
        // 余额分布（含往月仍有余的包）
        livePackages: liveCount,
        soonestExpiry,
        allTime: {
            capacity: allCapacity,
            remaining: allRemaining,
            used: allUsed
        }
    };
}

/**
 * 读取签到/积分状态文件
 */
function loadBillingState() {
    const file = join(process.cwd(), BILLING_STATE_DIR, BILLING_STATE_FILE);
    if (!existsSync(file)) return {};
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * 保存签到/积分状态文件（按 user_id 记录）
 * 清理旧版定时签到方案遗留的 autoCheckinEnabled/checkinTime 字段，
 * 保留 autoCheckinOnStartup（启动自动签到开关）
 *
 * 并发防护（PM2 多 worker + 独立定时脚本同时写）：
 * - 写前重读磁盘并合并：只覆盖本次声明触碰的 user 键（touchedKeys），其余键与 _config/_schedule 保留磁盘版本
 * - 原子写：先写 .tmp.<pid> 再 rename，避免读侧读到半截 JSON（那会丢幂等标记）
 * 注意：幂等的真正守卫是上游状态（performCheckin 先查上游），本地文件只是省一次网络调用，
 * 因此并发最坏后果是多打几次只读查询，不会重复领奖。
 *
 * @param {Object} state - 待写入的状态对象
 * @param {Object} [opts]
 * @param {Set<string>} [opts.touchedKeys] - 本次改动的 user 键集合；未提供时视为写入全部（兼容旧调用）
 */
function saveBillingState(state, {touchedKeys = null} = {}) {
    // 清理旧版定时器遗留字段，避免无意义数据持续占用
    if (state && typeof state === 'object' && state._config) {
        delete state._config.autoCheckinEnabled;
        delete state._config.checkinTime;
    }
    const dir = join(process.cwd(), BILLING_STATE_DIR);
    if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
    const file = join(dir, BILLING_STATE_FILE);

    // 一律写前重读磁盘：本进程持有的 state 是"进入函数前的快照"，在多 worker / 定时脚本
    // 并发场景下可能已过期。只把本次真正改动的部分覆盖上去，其余保留磁盘版本。
    // - 传了 touchedKeys：只覆盖这些 user 键（签到流程）
    // - 未传 touchedKeys：调用方只改 _config/_schedule，user 键一律保留磁盘版本
    let merged = state;
    if (state && typeof state === 'object') {
        const disk = loadBillingState();
        merged = {...disk};
        for (const key of Object.keys(state)) {
            if (key === '_config' || key === '_schedule') continue;
            if (touchedKeys === null) {
                // 未声明触碰范围：磁盘有新值就保留，避免用旧快照覆盖他人写入
                if (!(key in disk)) merged[key] = state[key];
            } else if (touchedKeys.has(key) || !(key in disk)) {
                merged[key] = state[key];
            }
        }
        // 配置段/调度段以内存版本为准（本进程刚读过/写过）
        if (state._config) merged._config = state._config;
        if (state._schedule) merged._schedule = state._schedule;
    }

    const tmp = `${file}.tmp.${process.pid}`;
    try {
        writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
        renameSync(tmp, file);
    } catch (err) {
        logger.error(`[CodeBuddy billing] 状态保存失败: ${err.message}`);
        try {
            if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
            /* ignore */
        }
    }
}

/**
 * 构造计费接口请求头（复用聊天请求的凭证字段）
 */
function billingHeaders(credential) {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${credential.bearer_token}`,
        'X-User-Id': credential.user_id || '',
        'X-Domain': credential.domain || 'www.codebuddy.cn',
        'X-Product': 'SaaS',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'CLI/2.95.1'
    };
}

/**
 * 按凭证所属区域解析计费接口基址
 *
 * 国际站与国内站是两套后端，接口路径与返回结构完全一致，只有域名不同。
 * 用账号自己的 base_url / domain 判断，比写死更稳（企业站域名因企业而异）。
 * @param {Object} credential
 * @returns {string} 形如 https://www.codebuddy.cn/v2/billing/meter/
 */
function billingBaseFor(credential) {
    const baseUrl = String(credential?.base_url || '').trim();
    if (baseUrl) {
        try {
            const origin = new URL(baseUrl).origin;
            return `${origin}${BILLING_PATH}`;
        } catch {
            // base_url 不合法就落到默认
        }
    }
    return `https://www.codebuddy.cn${BILLING_PATH}`;
}

/**
 * 调用计费接口并校验返回
 * @param {Object} credential
 * @param {string} path - 接口路径（如 get-user-resource）
 * @param {Object} body - 请求体
 * @returns {Promise<Object>} 返回 data 字段
 */
async function callBilling(credential, path, body = {}) {
    const response = await request(billingBaseFor(credential) + path, {
        method: 'POST',
        headers: billingHeaders(credential),
        body: JSON.stringify(body),
        timeout: 20000
    });

    if (response.status !== 200) {
        const err = new Error(`计费接口 ${path} 返回 HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }

    const raw = await readBody(response.body);
    let json;
    try {
        json = JSON.parse(raw);
    } catch {
        throw new Error(`计费接口 ${path} 返回非 JSON`);
    }

    if (!json || typeof json !== 'object' || json.code !== 0) {
        const code = json && typeof json === 'object' ? json.code : 'unknown';
        throw new Error(`计费接口 ${path} 返回错误 code=${code}`);
    }
    return json.data;
}

/**
 * 查询账号当前周期剩余积分
 *
 * 国内站（copilot.tencent.com / www.codebuddy.cn）与国际站（www.codebuddy.ai）
 * 走**同一个**计费接口与同一套字段，只是域名和 X-Domain 头不同，
 * 所以这里不按站点分支，直接复用。企业站没有个人资源包（TotalCount=0），
 * 会在下游表现为 0 额度，无需特殊处理。
 *
 * @param {Object} credential
 * @returns {Promise<{remaining:number, capacity:number, used:number, packages:number}>}
 */
export async function queryCredits(credential) {
    if (!credential || !credential.bearer_token) {
        throw new Error('缺少有效凭证');
    }
    if (!isBillableCredential(credential)) {
        throw new Error('该账号没有个人积分体系（企业站无个人资源包）');
    }

    const packages = [];
    const now = new Date();
    const begin = formatCNTime(now);
    const end = '2126-01-01 00:00:00';

    for (let page = 1; page <= 100; page++) {
        const data = await callBilling(credential, 'get-user-resource', {
            PageNumber: page,
            PageSize: 100,
            ProductCode: 'p_tcaca',
            Status: [0, 3],
            PackageEndTimeRangeBegin: begin,
            PackageEndTimeRangeEnd: end
        });

        let accounts;
        let total;
        try {
            accounts = data.Response.Data.Accounts;
            total = parseInt(data.Response.Data.TotalCount, 10);
            if (!Array.isArray(accounts) || total < 0) throw new Error('bad shape');
        } catch {
            throw new Error('积分数据格式异常');
        }

        packages.push(...accounts);
        if (packages.length >= total) break;
        if (accounts.length === 0) break;
    }

    return summarizePackages(packages);
}

/**
 * 查询签到状态
 * 优先 checkin-activity-status（活动签到），404/405 回退 checkin-status
 * @returns {Promise<{active:boolean, checked:boolean, streakDays:number, dailyCredit:number}>}
 */
async function queryCheckinStatus(credential) {
    let data;
    try {
        data = await callBilling(credential, 'checkin-activity-status', {});
    } catch (err) {
        // 活动签到接口不存在（404）或方法不允许（405）时才回退基础签到接口；
        // 网络错误、5xx 等其它异常直接抛出，避免误判为"无签到活动"
        if (err.status === 404 || err.status === 405) {
            data = await callBilling(credential, 'checkin-status', {});
        } else {
            throw err;
        }
    }

    if (!data || typeof data !== 'object') {
        throw new Error('签到状态格式异常');
    }

    const toBool = (v) => v === true || v === 1 || v === 'true' || v === '1';
    const active = toBool(data.active);
    const checked = toBool(data.today_checked_in ?? data.todayCheckedIn);
    if (data.active === undefined && data.today_checked_in === undefined && data.todayCheckedIn === undefined) {
        throw new Error('签到状态缺少必要字段');
    }
    return {
        active,
        checked,
        streakDays: parseInt(data.streak_days || 0, 10),
        dailyCredit: parseNumber(data.daily_credit)
    };
}

/**
 * 判断是否为国内站凭证（签到、成长中心只在国内个人站有效）
 */
function isDomestic(credential) {
    const domain = String(credential.domain || '').toLowerCase();
    const baseUrl = String(credential.base_url || '').toLowerCase();
    return (
        domain.includes('codebuddy.cn') ||
        domain.includes('copilot.tencent.com') ||
        baseUrl.includes('copilot.tencent.com')
    ) && !domain.includes('workbuddy.ai');
}

/**
 * 判断凭证是否有"个人积分体系"（能查积分包）
 *
 * 国内站与国际站都有（同一个 get-user-resource 接口，字段也一致）。
 * 企业站没有个人资源包，上游会返回 TotalCount=0，查了也是空，直接排除。
 * @param {Object} credential
 * @returns {boolean}
 */
function isBillableCredential(credential) {
    if (!credential || !credential.bearer_token) return false;
    // 企业账号的积分在另一套接口上（get-enterprise-user-usage），这里不处理
    if (credential.enterprise_id || credential.enterpriseId) return false;
    const domain = String(credential.domain || '').toLowerCase();
    const baseUrl = String(credential.base_url || '').toLowerCase();
    return (
        domain.includes('codebuddy.cn') ||
        domain.includes('codebuddy.ai') ||
        domain.includes('workbuddy.ai') ||
        domain.includes('copilot.tencent.com') ||
        baseUrl.includes('codebuddy.cn') ||
        baseUrl.includes('codebuddy.ai') ||
        baseUrl.includes('workbuddy.ai') ||
        baseUrl.includes('copilot.tencent.com')
    );
}

/**
 * 执行签到（幂等：已签则直接返回）
 * @returns {Promise<{checked:boolean, message:string, dailyCredit:number}>}
 */
export async function performCheckin(credential) {
    if (!credential || !credential.bearer_token) {
        throw new Error('缺少有效凭证');
    }
    if (!isDomestic(credential)) {
        throw new Error('仅支持国内站账号签到');
    }

    const status = await queryCheckinStatus(credential);
    if (status.checked) {
        return {checked: true, message: '今日已签到', dailyCredit: status.dailyCredit};
    }
    if (!status.active) {
        return {checked: false, message: '当前没有可参与的签到活动', dailyCredit: 0};
    }

    // 提交签到，随后再查一次确认
    await callBilling(credential, 'daily-checkin', {});
    const after = await queryCheckinStatus(credential);
    if (!after.checked) {
        throw new Error('签到已提交，但上游尚未确认，请稍后刷新');
    }
    return {checked: true, message: '签到成功', dailyCredit: after.dailyCredit};
}

/**
 * 获取北京时间的 HH:mm 字符串
 */
function formatCNTime(date) {
    return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 获取北京时间当天日期（YYYY-MM-DD）
 */
function cnToday() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 获取所有国内站凭证（不参与轮换，独立遍历）
 */
export function getDomesticCredentials() {
    const tm = credentialStore.getTokenManager();
    return tm.credentials
        .map((c) => c.data)
        .filter((c) => c.bearer_token && isDomestic(c));
}

/**
 * 获取所有能查积分的凭证（国内站 + 国际站）
 *
 * 与 getDomesticCredentials 的区别：那个只给签到/成长中心用（国际站没有这些活动），
 * 这个给面板的「积分与签到」用——积分本身两边都有。
 * @returns {Array}
 */
export function getBillableCredentials() {
    const tm = credentialStore.getTokenManager();
    return tm.credentials
        .map((c) => c.data)
        .filter((c) => isBillableCredential(c));
}

/**
 * 读取"启动时自动签到与成长日常"开关（默认开启）
 *
 * 默认开启的理由：这是本项目对签到/成长的**唯一自动化入口**——不注册系统计划任务，
 * 只在服务启动时跑一次。若默认关闭，绝大多数用户永远不会签到。
 * 仅当用户显式在面板取消勾选（存 false）时才跳过。
 */
export function getStartupCheckinConfig() {
    const state = loadBillingState();
    return state._config?.autoCheckinOnStartup !== false;
}

/**
 * 设置"启动自动签到"开关
 * @param {boolean} enabled
 */
export function setStartupCheckinConfig(enabled) {
    const state = loadBillingState();
    state._config = {...state._config, autoCheckinOnStartup: enabled === true};
    saveBillingState(state);
}

/**
 * 记录一次调度运行（供面板展示"最近一次补跑时间"）
 * @param {string} kind - 'startup' | 'checkin' | 'growth'
 * @param {Object} [extra]
 */
export function recordScheduleRun(kind, extra = {}) {
    const state = loadBillingState();
    state._schedule = {
        ...(state._schedule || {}),
        [`last${kind.charAt(0).toUpperCase()}${kind.slice(1)}Run`]: Date.now(),
        ...extra
    };
    saveBillingState(state);
}

/**
 * 读取调度状态（供面板展示）
 * @returns {Object}
 */
export function getScheduleState() {
    const state = loadBillingState();
    return state._schedule || {};
}

/**
 * 遍历所有国内站凭证执行签到（幂等：本地 checkinDate 日粒度 + performCheckin 内部再查上游）
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false] - true 时忽略"启动自动签到"开关门控
 *   （供独立定时脚本使用：定时任务本身就是显式意图，不应再受启动开关限制）
 * @returns {Promise<Array<{userId, checked, message}>>}
 */
export async function checkinAllDomestic({force = false} = {}) {
    // 非强制且开关关闭则跳过
    if (!force && !getStartupCheckinConfig()) {
        return [];
    }

    const today = cnToday();
    const state = loadBillingState();
    const credentials = getDomesticCredentials();
    const results = [];
    const touched = new Set();

    for (const cred of credentials) {
        const userId = cred.user_id || 'unknown';
        const rec = state[userId] || {};
        // 今日已签，跳过
        if (rec.checkinDate === today) {
            results.push({userId, checked: true, message: '今日已签到，跳过'});
            continue;
        }

        try {
            const result = await performCheckin(cred);
            state[userId] = {...rec, checkinDate: today, lastCheckinResult: result.message};
            results.push({userId, checked: result.checked, message: result.message});
            touched.add(userId);
            logger.info(`[CodeBuddy billing] 签到 user=${userId}: ${result.message}`);
        } catch (err) {
            state[userId] = {...rec, lastCheckinResult: err.message};
            results.push({userId, checked: false, message: err.message});
            touched.add(userId);
            logger.warn(`[CodeBuddy billing] 签到失败 user=${userId}: ${err.message}`);
        }
    }

    // 统一写一次文件（避免循环内频繁读写）；只声明本次触碰的 user 键，保护其他进程的写入
    saveBillingState(state, {touchedKeys: touched});
    return results;
}

/**
 * 启动时签到检查：遍历所有国内站凭证，对当天未签到的账号执行补签。
 * 幂等：以 billing_state.json 里的 checkinDate 为准，今天已签则跳过。
 * 受"启动自动签到"开关控制（关闭则不执行）。
 *
 * @returns {Promise<Array<{userId, checked, message}>>}
 */
export async function checkinOnStartup() {
    return checkinAllDomestic({force: false});
}

/**
 * 查询所有凭证的积分与签到状态（供管理面板展示）
 * 串行处理各账号（避免并发修改共享 state），最后统一写一次文件
 * @returns {Promise<Array<{userId, remaining, capacity, used, packages, checkinDate, checkedToday, stale, error}>>}
 */
export async function queryAllBillingStatus() {
    const state = loadBillingState();
    const today = cnToday();
    // 国内站 + 国际站：积分两边都有，只有签到/成长是国内站专属
    const credentials = getBillableCredentials();
    const results = [];

    for (const cred of credentials) {
        const userId = cred.user_id || 'unknown';
        const rec = state[userId] || {};
        // 国际站没有签到活动，面板上不显示签到按钮
        const supportsCheckin = isDomestic(cred);
        const entry = {
            userId,
            email: cred.user_info?.preferred_username || cred.user_info?.email || userId,
            // 站点标识：国内站与国际站的积分是两套独立的账，面板按它分组统计
            realm: supportsCheckin ? 'cn' : 'intl',
            supportsCheckin,
            remaining: rec.remaining ?? null,
            capacity: rec.capacity ?? null,
            used: rec.used ?? null,
            packages: rec.packages ?? null,
            soonestExpiry: rec.soonestExpiry ?? null,
            month: rec.month ?? null,
            monthLabel: rec.monthLabel ?? null,
            allTime: rec.allTime ?? null,
            creditsUpdated: rec.creditsUpdated || 0,
            checkinDate: rec.checkinDate || null,
            checkedToday: rec.checkinDate === today,
            stale: !rec.creditsUpdated || Date.now() - rec.creditsUpdated > CREDITS_STALE_MS,
            lastCheckinResult: rec.lastCheckinResult || null,
            error: null
        };

        try {
            const summary = await queryCredits(cred);
            entry.remaining = summary.remaining;
            entry.capacity = summary.capacity;
            entry.used = summary.used;
            entry.packages = summary.packages;
            entry.soonestExpiry = summary.soonestExpiry;
            entry.month = summary.month;
            entry.monthLabel = summary.monthLabel;
            entry.allTime = summary.allTime;
            entry.creditsUpdated = Date.now();
            entry.stale = false;
            state[userId] = {...state[userId], ...summary, creditsUpdated: Date.now()};
        } catch (err) {
            entry.error = err.message;
        }

        // 签到状态只有国内站有；国际站跳过，避免每次都打一个必然失败的请求
        if (supportsCheckin) {
            try {
                const status = await queryCheckinStatus(cred);
                if (status.checked) {
                    entry.checkinDate = today;
                    entry.checkedToday = true;
                    state[userId] = {...state[userId], checkinDate: today};
                }
            } catch {
                // 忽略签到状态查询失败
            }
        }

        results.push(entry);
    }

    // 统一写一次文件，避免循环内频繁读写及并发覆盖
    saveBillingState(state);
    return results;
}
