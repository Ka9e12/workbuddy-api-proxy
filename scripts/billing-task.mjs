#!/usr/bin/env node
/**
 * CodeBuddy 签到 / 成长中心定时任务 CLI
 *
 * 供 Windows 计划任务（scripts/schedule.ps1）或外部调度器调用。
 * 之所以用独立脚本而非进程内定时器：
 * - PM2 集群（4 worker）下进程内定时会各跑一份；
 * - 服务停止/关机期间的错过无法补跑（计划任务的 -StartWhenAvailable 才能补）。
 *
 * 幂等：签到先查上游（performCheckin）、成长日常每个动作先查状态，
 * 重复执行只会多打几次只读查询，不会重复领取。
 *
 * 用法：
 *   node scripts/billing-task.mjs checkin            # 遍历国内站凭证补签
 *   node scripts/billing-task.mjs growth             # 跑一遍成长日常
 *   node scripts/billing-task.mjs growth --wait-arrival  # 到站时间很近时就地等到站再领奖
 */

import '../src/load-env.js';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {join} from 'path';
import {performCheckin} from '../src/services/codebuddy/billing.js';
import {runGrowthDaily, queryTravelStatus, claimTravelReward, planArrivalWait} from '../src/services/codebuddy/growth.js';
import {CODEBUDDY_CREDS_DIR} from '../src/services/codebuddy/config.js';
import logger from '../src/utils/logger.js';

/** 直接读凭证目录（不依赖 credentialStore 单例的加载状态），只取含 bearer_token 的凭证 */
function loadCredentials() {
    const dir = join(process.cwd(), CODEBUDDY_CREDS_DIR, 'credentials');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            try {
                return JSON.parse(readFileSync(join(dir, f), 'utf8'));
            } catch {
                return null;
            }
        })
        .filter((c) => c && c.bearer_token);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCheckin() {
    const creds = loadCredentials();
    if (creds.length === 0) {
        logger.warn('[billing-task] 没有可用凭证');
        return 0;
    }
    let failed = 0;
    for (const cred of creds) {
        const userId = cred.user_id || 'unknown';
        try {
            const r = await performCheckin(cred);
            logger.info(`[billing-task] 签到 user=${userId}: ${r.message}`);
        } catch (err) {
            // 非国内站会抛"仅支持国内站账号签到"——属正常跳过，不算失败
            if (/仅支持国内站/.test(err.message)) continue;
            failed++;
            logger.warn(`[billing-task] 签到失败 user=${userId}: ${err.message}`);
        }
    }
    return failed;
}

async function runGrowth({waitArrival}) {
    const creds = loadCredentials();
    if (creds.length === 0) {
        logger.warn('[billing-task] 没有可用凭证');
        return 0;
    }
    let failed = 0;
    for (const cred of creds) {
        const userId = cred.user_id || 'unknown';
        try {
            const r = await runGrowthDaily(cred);
            if (r.skipped) continue;
            logger.info(`[billing-task] 成长日常 user=${userId}: ${JSON.stringify(r)}`);

            // 可选：到站时间很近时就地等到站再领奖
            if (waitArrival) {
                try {
                    const status = await queryTravelStatus(cred);
                    const plan = planArrivalWait(status);
                    if (plan.shouldWait) {
                        logger.info(`[billing-task] user=${userId} 等待 ${Math.round(plan.waitMs / 1000)}s 到站后领奖`);
                        await sleep(plan.waitMs);
                        const claim = await claimTravelReward(cred);
                        logger.info(`[billing-task] user=${userId} 到站领奖: ${JSON.stringify(claim)}`);
                    }
                } catch (err) {
                    logger.warn(`[billing-task] user=${userId} 到站领奖失败: ${err.message}`);
                }
            }
        } catch (err) {
            failed++;
            logger.warn(`[billing-task] 成长日常失败 user=${userId}: ${err.message}`);
        }
    }
    return failed;
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args.find((a) => !a.startsWith('--'));
    const waitArrival = args.includes('--wait-arrival');

    if (mode !== 'checkin' && mode !== 'growth') {
        console.error('用法: node scripts/billing-task.mjs <checkin|growth> [--wait-arrival]');
        process.exit(2);
    }

    const failed = mode === 'checkin' ? await runCheckin() : await runGrowth({waitArrival});
    // 只设置退出码、不调用 process.exit()：logger 用 process.nextTick 异步输出，
    // 直接 exit 会丢弃尚未刷出的日志，导致计划任务出问题时完全无记录可查。
    // 设为非 0 表示"需关注"（有账号失败），便于计划任务/监控识别。
    process.exitCode = failed > 0 ? 1 : 0;
    // 给异步日志一个刷出机会（nextTick 在事件循环末尾执行，setImmediate 可确保其后）
    await new Promise((r) => setImmediate(r));
}

main().catch((err) => {
    console.error('任务执行异常:', err.message);
    process.exitCode = 1;
});
