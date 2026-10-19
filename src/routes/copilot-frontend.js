/**
 * Copilot 前端管理界面路由
 * 提供 Web UI 用于 GitHub 认证、API Key 管理、用量统计、代理配置
 * @module routes/copilot-frontend
 */

import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import logger from '../utils/logger.js';
import {copilotStore} from '../services/copilot/copilot-store.js';
import {getGatewayApiKeyInfo, regenerateGatewayToken} from '../services/gateway/auth.js';
import {startDeviceAuth, pollDeviceAuth, clearAuthentication, isAuthenticated} from '../services/copilot/auth.js';
import {shutdown as shutdownCopilotWsPool} from '../services/copilot/copilot-ws-pool.js';
import {gatherAllStats, broadcast} from '../utils/cluster-broadcaster.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');
const GITHUB_AUTH_TIMEOUT = 20000;

function readTemplate(name) {
    return readFileSync(join(templatesDir, name), 'utf8');
}

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

function maskProxyUrl(proxyUrl) {
    if (!proxyUrl) return 'direct';
    try {
        const parsed = new URL(proxyUrl);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '***';
        }
        return parsed.toString();
    } catch {
        return proxyUrl;
    }
}

function getGithubAuthNetworkOptions() {
    return {
        proxyUrl: copilotStore.getProxyUrl(),
        rejectUnauthorized: copilotStore.getRejectUnauthorized(),
        timeout: GITHUB_AUTH_TIMEOUT
    };
}

function withTimeout(promise, timeout, message) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * 整体状态
 */
async function handleStatus(req, res) {
    const apiInfo = getGatewayApiKeyInfo();
    const usage = await gatherAllStats('copilot');
    const tokenStatus = copilotStore.getTokenStatus();
    const userInfo = copilotStore.getUserInfo();
    const proxyConfig = copilotStore.getProxyConfig();
    sendJson(res, 200, {
        authenticated: isAuthenticated(),
        userInfo,
        tokenStatus,
        apiKeyPrefix: apiInfo.prefix,
        apiKeyPlain: apiInfo.apiKeyPlain,
        usage,
        proxy: proxyConfig.proxy || '',
        skip_tls_verify: proxyConfig.skip_tls_verify === true
    });
}

/**
 * 启动 GitHub 设备码认证
 */
async function handleAuthStart(req, res) {
    try {
        const networkOptions = getGithubAuthNetworkOptions();
        logger.info(`Starting GitHub device auth via ${maskProxyUrl(networkOptions.proxyUrl)}, skip TLS verify: ${!networkOptions.rejectUnauthorized}`);
        const deviceData = await withTimeout(
            startDeviceAuth(networkOptions.proxyUrl, networkOptions),
            GITHUB_AUTH_TIMEOUT + 2000,
            'GitHub 认证请求超时，请检查代理配置'
        );
        sendJson(res, 200, {
            success: true,
            device_code: deviceData.device_code,
            user_code: deviceData.user_code,
            verification_uri: deviceData.verification_uri,
            expires_in: deviceData.expires_in,
            interval: deviceData.interval || 5
        });
    } catch (error) {
        logger.error('Failed to start device auth:', error);
        sendJson(res, 500, {success: false, error: error.message});
    }
}

/**
 * 轮询认证状态（单次查询，前端控制轮询频率）
 */
async function handleAuthPoll(req, res) {
    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);
        const {device_code} = data;

        if (!device_code) {
            return sendJson(res, 400, {error: 'missing device_code'});
        }

        const networkOptions = getGithubAuthNetworkOptions();
        const result = await withTimeout(
            pollDeviceAuth(device_code, networkOptions.proxyUrl, networkOptions),
            GITHUB_AUTH_TIMEOUT + 2000,
            'GitHub 授权轮询超时，请检查代理配置'
        );
        sendJson(res, 200, {
            status: 'success',
            message: '认证成功！',
            user_info: {
                login: result.userInfo.login,
                name: result.userInfo.name,
                avatar_url: result.userInfo.avatar_url
            }
        });
    } catch (error) {
        const code = error.code || '';
        if (code === 'authorization_pending') {
            sendJson(res, 200, {status: 'pending', message: '等待用户授权...'});
        } else if (code === 'slow_down') {
            sendJson(res, 200, {status: 'slow_down', message: '轮询过快，请降低频率', interval: 10});
        } else if (code === 'expired_token') {
            sendJson(res, 200, {status: 'expired', message: '设备码已过期，请重新发起认证'});
        } else if (code === 'access_denied') {
            sendJson(res, 200, {status: 'denied', message: '用户拒绝授权'});
        } else {
            logger.error('Auth poll error:', error);
            sendJson(res, 500, {status: 'error', message: error.message});
        }
    }
}

/**
 * 清除认证
 */
function handleAuthClear(req, res) {
    clearAuthentication();
    sendJson(res, 200, {message: '认证已清除'});
}

/**
 * 获取凭证信息
 */
function handleCredentials(req, res) {
    const tokenStatus = copilotStore.getTokenStatus();
    const userInfo = copilotStore.getUserInfo();
    sendJson(res, 200, {tokenStatus, userInfo});
}

/**
 * 获取 API Key 信息
 */
function handleApiKey(req, res) {
    const info = getGatewayApiKeyInfo();
    sendJson(res, 200, {prefix: info.prefix, apiKeyPlain: info.apiKeyPlain});
}

/**
 * 重新生成 API Key（网关令牌，影响所有端点）
 */
function handleRegenerateApiKey(req, res) {
    try {
        const newKey = regenerateGatewayToken();
        sendJson(res, 200, {
            message: 'API Key 已重新生成，新 Key 仅显示一次！重置将同时影响所有端点（Copilot/CodeBuddy/Relay）',
            api_key: newKey
        });
    } catch (error) {
        logger.error('Failed to regenerate API Key:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 获取每日用量
 */
function handleDailyStats(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const month = urlObj.searchParams.get('month') || '';
    if (!month) {
        return sendJson(res, 400, {error: '缺少 month 参数'});
    }
    const dailyData = copilotStore.getDailyUsage(month);
    const availableMonths = copilotStore.getAvailableMonths();
    sendJson(res, 200, {month, data: dailyData, available_months: availableMonths});
}

/**
 * 获取代理配置
 */
function handleProxyGet(req, res) {
    sendJson(res, 200, copilotStore.getProxyConfig());
}

/**
 * 更新代理配置
 */
async function handleProxyUpdate(req, res) {
    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);
        // 兼容旧格式和新格式
        const proxy = data.proxy || data.https_proxy || data.http_proxy || '';
        const skipTlsVerify = data.skip_tls_verify === true || data.skipTlsVerify === true || data.reject_unauthorized === false || data.rejectUnauthorized === false;
        const changed = copilotStore.updateProxyConfig(proxy, skipTlsVerify);
        if (changed) shutdownCopilotWsPool();
        sendJson(res, 200, {message: '代理配置已更新', ...copilotStore.getProxyConfig()});
    } catch (error) {
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 管理面板 HTML
 */
function serveAdminPage(res) {
    const html = readTemplate('copilot-admin.html');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}

/**
 * 主路由处理函数
 */
export async function routeCopilotFrontend(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/copilotFE' || pathname === '/copilotFE/') {
        return serveAdminPage(res);
    }

    if (pathname === '/copilotFE/status' && method === 'GET') {
        return handleStatus(req, res);
    }

    if (pathname === '/copilotFE/auth/start' && method === 'GET') {
        return handleAuthStart(req, res);
    }
    if (pathname === '/copilotFE/auth/poll' && method === 'POST') {
        return handleAuthPoll(req, res);
    }
    if (pathname === '/copilotFE/auth/clear' && method === 'POST') {
        return handleAuthClear(req, res);
    }

    if (pathname === '/copilotFE/credentials' && method === 'GET') {
        return handleCredentials(req, res);
    }

    if (pathname === '/copilotFE/apikey' && method === 'GET') {
        return handleApiKey(req, res);
    }
    if (pathname === '/copilotFE/apikey/regenerate' && method === 'POST') {
        return handleRegenerateApiKey(req, res);
    }

    if (pathname === '/copilotFE/stats' && method === 'GET') {
        const usage = await gatherAllStats('copilot');
        return sendJson(res, 200, usage);
    }
    if (pathname === '/copilotFE/stats/refresh' && method === 'POST') {
        await broadcast('stats-flush');
        copilotStore.flushApiCallCounts();
        const usage = await gatherAllStats('copilot');
        return sendJson(res, 200, {message: '数据已刷新', usage});
    }
    if (pathname === '/copilotFE/stats/custom-reset' && method === 'POST') {
        copilotStore.resetCustomStats();
        await broadcast('stats-reset', {service: 'copilot'});
        const usage = await gatherAllStats('copilot');
        return sendJson(res, 200, {message: '自定义统计数据已重置', usage});
    }
    if (pathname === '/copilotFE/stats/daily' && method === 'GET') {
        return handleDailyStats(req, res);
    }

    if (pathname === '/copilotFE/proxy' && method === 'GET') {
        return handleProxyGet(req, res);
    }
    if (pathname === '/copilotFE/proxy' && method === 'POST') {
        return handleProxyUpdate(req, res);
    }

    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Not found'}));
}
