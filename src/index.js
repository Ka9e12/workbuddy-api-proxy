#!/usr/bin/env node

/**
 * 应用入口
 * @module index
 */

import './load-env.js';
import {networkInterfaces} from 'os';
import readline from 'readline';
import {createServer} from './server.js';
import {isAuthenticated, refreshCopilotToken} from './services/copilot/auth.js';
import {copilotStore} from './services/copilot/copilot-store.js';
import {credentialStore} from './services/codebuddy/credential-store.js';
import {checkinOnStartup, queryCredits, getStartupCheckinConfig, recordScheduleRun} from './services/codebuddy/billing.js';
import {runGrowthDaily, getGrowthCredentials} from './services/codebuddy/growth.js';
import {getModelPricing} from './services/codebuddy/api.js';
import {relayStore} from './services/relay/relay-store.js';
import {initGatewayAuth, isAdminAuthEnabled, isGatewayAuthEnabled} from './services/gateway/auth.js';
import {shutdown as shutdownCopilotWSPool} from './services/copilot/copilot-ws-pool.js';
import {shutdownWSPool as shutdownRelayWSPool} from './services/relay/api.js';
import {intEnv} from './utils/env.js';
import logger from './utils/logger.js';

// 配置
const PORT = intEnv('PORT', {default: 3088, min: 1, max: 65535});
const HOST = process.env.HOST || '0.0.0.0';
const AUTO_AUTH = false; // FE-based auth, no console auth

// 获取本机内网 IP 地址
function getLocalIp() {
    for (const interfaces of Object.values(networkInterfaces())) {
        for (const iface of interfaces) {
            if (!iface.internal && iface.family === 'IPv4') {
                return iface.address;
            }
        }
    }
    return null;
}

/**
 * 选择对外展示的主机名。
 *
 * 绑定到 loopback 时必须显示 127.0.0.1：此时内网 IP 并不在监听范围内，
 * 打印它等于给一个连不上的地址。绑定 0.0.0.0 时才用内网 IP，方便同网段设备访问。
 */
function getDisplayHost() {
    if (HOST === 'localhost' || HOST === '::1' || HOST.startsWith('127.')) return HOST;
    return getLocalIp() || 'localhost';
}

/**
 * 初始化 Copilot 服务
 */
function initializeCopilot() {
    if (isAuthenticated()) {
        (async () => {
            try {
                const proxyUrl = copilotStore.getProxyUrl();
                await refreshCopilotToken(proxyUrl, {
                    rejectUnauthorized: copilotStore.getRejectUnauthorized()
                });
            } catch (error) {
                logger.warn('Failed to refresh Copilot token:', error.message);
            }
        })();
    } else {
        logger.info('Copilot not authenticated');
        logger.info('  Please visit /copilotFE to authenticate with GitHub');
    }
}

/**
 * 初始化 CodeBuddy 服务
 *
 * 自动化任务的默认形态：**服务启动时跑一次**签到与成长日常，不注册任何系统计划任务。
 * 若用户希望一天多次（例如猫猫旅行到站后及时领奖），可在面板按指引自行配置，
 * 属于可选增强，不影响默认行为。
 */
function initializeCodebuddy() {
    const hasCredentials = credentialStore.hasCredentials();
    if (hasCredentials) {
        const tm = credentialStore.getTokenManager();
        const info = tm.getCurrentCredentialInfo();

        // 启动时签到与成长日常（默认开启，面板可关闭），异步执行不阻塞服务启动
        checkinOnStartup()
            .then((results) => {
                // 记录本次启动运行时间，供面板展示
                try {
                    recordScheduleRun('startup', {startupCheckinCount: results.length});
                } catch {
                    /* ignore */
                }
                if (results.length > 0) {
                    logger.info(`[CodeBuddy] 启动签到完成：${results.length} 个账号`);
                }
                // 成长日常与签到共用同一开关
                if (!getStartupCheckinConfig()) {
                    logger.info('[CodeBuddy] 启动自动化已在面板中关闭，跳过成长日常');
                    return;
                }
                const creds = getGrowthCredentials();
                if (creds.length === 0) return;
                (async () => {
                    for (const cred of creds) {
                        try {
                            const r = await runGrowthDaily(cred);
                            logger.info(`[CodeBuddy growth] 启动成长日常 user=${cred.user_id || 'unknown'}: ${JSON.stringify(r)}`);
                        } catch (err) {
                            logger.warn(`[CodeBuddy growth] 启动成长日常失败 user=${cred.user_id || 'unknown'}: ${err.message}`);
                        }
                    }
                })();
            })
            .catch((err) => {
                logger.warn('启动签到检查异常:', err.message);
            });
    } else {
        logger.info('No CodeBuddy credentials found');
        logger.info('  Please add credentials via the admin panel: /codebuddyFE');
    }
}

/**
 * 初始化 Relay 服务
 */
function initializeRelay() {
}

/**
 * 格式化倍率字符串，未定价显示为 "免费"
 */
function formatCredits(creditsValue) {
    if (creditsValue === null) return '无';
    if (creditsValue === 0) return '免费';
    return `x${creditsValue}`;
}

/**
 * 打印实时模型价格表到控制台
 * 直接请求上游 /v3/config，不读缓存，确保展示最新计费倍率
 */
async function printPriceTable() {
    const credential = credentialStore.peekCredential();
    if (!credential) {
        console.log('⚠ 没有可用的 CodeBuddy 凭证，无法查询价格。请先在 /codebuddyFE 添加凭证。');
        return;
    }

    console.log('\n正在拉取上游实时价格表...');
    try {
        const pricing = await getModelPricing(credential);
        if (!pricing || pricing.length === 0) {
            console.log('⚠ 未获取到模型价格数据。');
            return;
        }

        // 按厂商分组后按倍率升序展示
        const byVendor = new Map();
        for (const m of pricing) {
            if (!byVendor.has(m.vendor)) byVendor.set(m.vendor, []);
            byVendor.get(m.vendor).push(m);
        }
        for (const list of byVendor.values()) {
            list.sort((a, b) => (a.creditsValue ?? Infinity) - (b.creditsValue ?? Infinity));
        }

        const vendorNames = {deepseek: 'DeepSeek', zhipu: '智谱 GLM', moonshot: 'Kimi', minimax: 'MiniMax', hunyuan: '腾讯混元', others: '其他'};
        const cacheHint = pricing._fromCache ? '（上游拉取失败，显示最近一次结果）' : '';
        console.log(`\n========== CodeBuddy 实时模型价格表${cacheHint} ==========`);
        console.log('倍率 = 腾讯 credits 相对计价（x 越大烧钱越快），非人民币');
        console.log('');

        for (const [vendor, list] of byVendor) {
            console.log(`【${vendorNames[vendor] || vendor}】`);
            for (const m of list) {
                const credits = formatCredits(m.creditsValue);
                const ctxIn = m.maxInputTokens ? `${(m.maxInputTokens / 10000).toFixed(1)}万` : '-';
                const ctxOut = m.maxOutputTokens ? `${(m.maxOutputTokens / 10000).toFixed(1)}万` : '-';
                console.log(
                    `  ${m.id.padEnd(24)} ${credits.padEnd(7)} 输入 ${ctxIn.padStart(7)}  输出 ${ctxOut.padStart(7)}`
                );
            }
            console.log('');
        }
        console.log('=============================================\n');
        console.log('提示：输入p/price/价格 可随时重新查询；输入h/help/帮助 查看指令；输入q/exit/退出 关闭服务。\n');
    } catch (error) {
        console.log(`⚠ 查询价格失败: ${error.message}`);
    }
}

/**
 * 打印今日累计积分消耗量与当前积分余额
 * 今日消耗 = 本地 daily_usage 累计（代理统计）
 * 余额 = 实时查询上游（含分页聚合）
 */
async function printBalance() {
    const credential = credentialStore.peekCredential();
    if (!credential) {
        console.log('⚠ 没有可用的 CodeBuddy 凭证。请先在 /codebuddyFE 添加凭证。');
        return;
    }

    // 今日累计积分消耗量（本地统计）
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dayKey = String(now.getDate()).padStart(2, '0');
    const daily = credentialStore.getDailyUsage(monthKey);
    const today = daily[dayKey] || {};
    const todayCredit = today.credit || 0;

    console.log('\n========== 积分余额与今日消耗 ==========');
    console.log(`今日累计消耗: ${todayCredit.toFixed(2)} credits`);
    console.log(`今日 API 调用: ${today.api_calls || 0} 次`);

    // 实时查询当前余额
    console.log('\n正在查询上游实时积分余额...');
    try {
        const summary = await queryCredits(credential);
        console.log(`当前剩余积分: ${summary.remaining.toFixed(2)} credits`);
        console.log(`可用总额: ${summary.capacity.toFixed(2)} credits`);
        console.log(`已消耗(周期): ${summary.used.toFixed(2)} credits`);
        console.log(`积分包数量: ${summary.packages} 个`);
    } catch (error) {
        console.log(`⚠ 查询余额失败: ${error.message}`);
    }
    console.log('=========================================\n');
}

/**
 * 打印交互指令帮助
 */
function printHelp() {
    const host = getDisplayHost();
    const base = `http://${host}:${PORT}`;
    console.log('\n========== 控制台指令 ==========');
    console.log('  p/price/价格    查询上游实时模型价格表');
    console.log('  b/balance/余额  查看今日积分消耗与当前余额');
    console.log('  h/help/帮助     显示本帮助');
    console.log('  q/exit/退出     关闭代理服务');
    console.log('');
    console.log('========== 端点清单 ==========');
    for (const [label, prefix] of [['CodeBuddy', 'codebuddy'], ['Copilot', 'copilot'], ['Relay', 'relay']]) {
        console.log(`  ${label}`);
        console.log(`    管理面板   ${base}/${prefix}FE`);
        console.log(`    OpenAI     ${base}/${prefix}/v1`);
        console.log(`    Anthropic  ${base}/${prefix}/anthropic`);
        console.log(`    WS         ws://${host}:${PORT}/${prefix}/v1/responses`);
    }
    console.log('================================\n');
}

/**
 * 启动控制台交互（在代理窗口内输入指令）
 */
function startConsoleREPL() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });

    rl.setPrompt('');
    rl.on('line', (line) => {
        const cmd = (line || '').trim().toLowerCase();
        if (!cmd) return;

        if (['price', '价格', 'p', '价'].includes(cmd)) {
            printPriceTable();
        } else if (['balance', '余额', 'b', '积分'].includes(cmd)) {
            printBalance();
        } else if (['help', '帮助', 'h', '?', '指令'].includes(cmd)) {
            printHelp();
        } else if (['exit', '退出', 'q', 'quit'].includes(cmd)) {
            console.log('\n正在关闭服务...');
            process.emit('SIGINT');
        } else {
            console.log(`未知指令: ${line}，输入 help 查看可用指令。`);
        }
    });
}

// 初始化并启动服务
(async () => {
    try {
        // 初始化 Gateway 鉴权（必须最早执行，读取环境变量并生成 RSA 密钥对）
        initGatewayAuth();

        // 初始化 Copilot（后台异步，不阻塞）
        initializeCopilot();

        // 初始化 CodeBuddy
        initializeCodebuddy();

        // 初始化 Relay
        initializeRelay();

        // 创建并启动服务器
        const server = createServer();

        server.listen(PORT, HOST, () => {
            const host = getDisplayHost();
            const base = `http://${host}:${PORT}`;
            // 只打最关键的三行：能打开的面板、接入点、鉴权状态。
            // 完整的端点清单（含 WS）用 h 指令随时可查，不必在启动时刷屏。
            console.log();
            console.log(`  ▸ 管理面板   ${base}`);
            console.log(`  ▸ 接入地址   ${base}/codebuddy/anthropic   (Claude Code / DSH)`);
            console.log(`              ${base}/codebuddy/v1            (Codex / OpenAI 兼容)`);
            console.log(`  ▸ 鉴权       ${isAdminAuthEnabled() ? '面板需登录' : '面板免密（建议设 ADMIN_PASSWORD）'} · ${isGatewayAuthEnabled() ? '网关需 Key' : '网关无 Key'}`);
            console.log(`  ▸ 监听       ${HOST}:${PORT}${HOST === '127.0.0.1' || HOST === 'localhost' ? '（仅本机）' : '（局域网可访问）'}`);
            console.log();
            console.log('  输入 h 查看全部指令。');
            console.log();

            // 启动控制台交互（输入 price 查询实时价格表等）
            startConsoleREPL();
        });

        // 优雅关闭
        const shutdown = async (signal) => {
            console.log(`\n${signal} received, shutting down gracefully...`);
            try {
                // 关闭 WS 连接池
                shutdownCopilotWSPool();
                shutdownRelayWSPool();

                await Promise.all([
                    credentialStore.flushApiCallCounts(),
                    copilotStore.flushApiCallCounts(),
                    relayStore.flushApiCallCounts()
                ]);
            } catch (err) {
                console.error('Error flushing data during shutdown:', err.message);
            }
            server.close(() => {
                console.log('Server closed');
                process.exit(0);
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        // 全局异常处理 — 防止进程因未捕获错误而静默崩溃
        process.on('uncaughtException', (err) => {
            console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, err);
            logger.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
            // 记录后优雅关闭，避免进程处于不确定状态
            shutdown('uncaughtException');
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION:`, reason);
            logger.error('UNHANDLED REJECTION:', reason?.message || reason, reason?.stack);
            // 不立即退出，避免非致命的 Promise 拒绝导致服务中断
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();
