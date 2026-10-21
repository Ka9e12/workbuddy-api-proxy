/**
 * HTTP 服务器核心逻辑
 * 支持 WebSocket 升级，将 WS 连接路由到对应的 Responses API WS 处理器
 * @module server
 */

import http from 'http';
import {URL} from 'url';
import {readFileSync} from 'fs';
import {join} from 'path';
import {WebSocketServer} from 'ws';
import logger from './utils/logger.js';
import {routeCopilotRequest, handleCopilotResponsesWS} from './routes/copilot.js';
import {routeCopilotFrontend} from './routes/copilot-frontend.js';
import {routeCodebuddyRequest, handleCodebuddyResponsesWS} from './routes/codebuddy.js';
import {routeCodebuddyFrontend} from './routes/codebuddy-frontend.js';
import {routeRelayRequest, handleRelayResponsesWS} from './routes/relay.js';
import {routeRelayFrontend} from './routes/relay-frontend.js';
import {
    serveLoginPage,
    getPublicKeyEndpoint,
    handleLoginRequest,
    handleLogoutRequest,
    handleClearCredentials,
    handleSetCredentials,
    requireAdminAuth,
    requireGatewayAuth
} from './services/gateway/admin-auth.js';
import {isGatewayAuthEnabled, resolveGatewayKey, reloadGatewayApiKeys, isAdminAuthEnabled, reloadAdminCredentials, reloadAdminCredentialsFromSync} from './services/gateway/auth.js';
import {copilotState} from './services/copilot/state.js';
import {copilotStore} from './services/copilot/copilot-store.js';
import {isAuthenticated} from './services/copilot/auth.js';
import {credentialStore} from './services/codebuddy/credential-store.js';
import {relayStore} from './services/relay/relay-store.js';
import {isClusterMode, getCurrentPort, getAllPorts} from './utils/cluster-broadcaster.js';

const APP_VERSION = (() => {
    try {
        return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || 'unknown';
    } catch {
        return 'unknown';
    }
})();

// 单请求体体积上限（默认 16MB）。携带超长历史 / 大内联附件 / 高分辨率图片的请求
// 会在解析前被拒（413），避免挤占内存。设为 0 表示不限制。
const MAX_PAYLOAD_BYTES = (() => {
    const raw = parseInt(process.env.MAX_PAYLOAD_BYTES, 10);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 16 * 1024 * 1024;
})();

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
    res.writeHead(status, {'Content-Type': 'text/plain'});
    res.end(message);
}

/**
 * 渲染 404 页面（HTML 给浏览器，JSON 给 API 客户端）
 */
function send404(req, res) {
    const accept = String(req.headers['accept'] || '');
    const wantsHtml = accept.includes('text/html');
    if (!wantsHtml) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Not found', path: req.url}));
        return;
    }
    const safePath = String(req.url || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - WorkBuddy API Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 520px; width: 100%; padding: 48px 24px; text-align: center; }
    .code { font-size: 6rem; font-weight: 800; color: #58a6ff; line-height: 1; letter-spacing: -2px; }
    h1 { font-size: 1.5rem; font-weight: 700; margin: 16px 0 8px; color: #f0f6fc; }
    .desc { color: #8b949e; margin-bottom: 8px; font-size: 0.95rem; }
    .path { display: inline-block; margin: 16px 0 32px; padding: 6px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #79c0ff; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.85rem; word-break: break-all; max-width: 100%; }
    .home-btn { display: inline-block; padding: 10px 20px; background: #238636; border: 1px solid #2ea043; border-radius: 8px; color: #ffffff; text-decoration: none; font-size: 0.9rem; font-weight: 500; transition: background 0.2s; }
    .home-btn:hover { background: #2ea043; }
  </style>
</head>
<body>
  <div class="container">
    <div class="code">404</div>
    <h1>页面不存在</h1>
    <p class="desc">您访问的路径不在已注册的路由中</p>
    <div class="path">${safePath}</div>
    <div>
      <a class="home-btn" href="/">返回首页</a>
    </div>
  </div>
</body>
</html>`;
    res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}

/**
 * WS 鉴权：检查网关令牌
 * WS 握手时支持以下方式传递令牌：
 * 1. Authorization: Bearer <token> header（随 upgrade 请求发送）
 * 2. api_key URL 参数：?api_key=<token>
 *
 * 与 HTTP 路径一样把 Key 记录挂到 req 上：WS 完全绕过 routeXxxRequest，
 * 只做布尔判定会让「按 Key 限定 CodeBuddy 账号」在 WS 通道失效。
 */
function requireGatewayAuthWS(req) {
    if (!isGatewayAuthEnabled()) {
        req._gatewayAuthenticated = true;
        return true;
    }

    // 从 URL 参数获取
    const url = new URL(req.url, `http://${req.headers.host}`);
    const apiKeyParam = url.searchParams.get('api_key');
    if (apiKeyParam) {
        const key = resolveGatewayKey(apiKeyParam);
        if (key) {
            req._gatewayAuthenticated = true;
            req._gatewayKey = key;
            return true;
        }
    }

    // 从 Authorization header 获取
    const auth = req.headers['authorization'];
    if (auth) {
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        const key = resolveGatewayKey(token);
        if (key) {
            req._gatewayAuthenticated = true;
            req._gatewayKey = key;
            return true;
        }
    }

    return false;
}

/**
 * 处理从其他 worker 接收的广播事件
 * @param {object} data - {type: string, sourcePort: number, ...}
 */
function handleBroadcastEvent(data) {
    const {type} = data;
    logger.debug(`Broadcast received: ${type} from worker port ${data.sourcePort}`);

    switch (type) {
        // Gateway
        case 'gateway-token-regenerated':
        case 'gateway-api-keys-changed':
            // 两个事件名指向同一个动作：混跑版本时旧 worker 发前者、新 worker 发后者，
            // 都表示「Key 列表在磁盘上变了，重读」。
            reloadGatewayApiKeys();
            break;
        case 'admin-credentials-cleared':
            reloadAdminCredentials();
            break;
        case 'admin-credentials-set':
            reloadAdminCredentialsFromSync(data.username, data.passwordHash);
            break;

        // Copilot
        case 'copilot-auth-cleared':
            copilotState.reload();
            break;
        case 'copilot-proxy-updated':
            copilotStore.reload();
            break;

        // CodeBuddy
        case 'codebuddy-credentials-changed':
            credentialStore.reload();
            break;
        case 'codebuddy-state-changed':
            credentialStore.getTokenManager().loadState();
            break;
        case 'codebuddy-ratelimit-reset':
            // 接收侧只重置本地内存标记，不再 broadcast（避免广播往返风暴）
            credentialStore.getTokenManager().resetRateLimit(data.index, {
                clearDisabled: data.clearDisabled === true
            });
            break;

        // Relay
        case 'relay-upstreams-changed':
            relayStore.getUpstreamManager()._loadUpstreams();
            break;
        case 'relay-settings-changed':
            relayStore.getUpstreamManager()._loadSettings();
            break;
        case 'relay-ratelimit-reset':
            // 接收侧只重置本地内存标记，不再 broadcast
            relayStore.getUpstreamManager().resetRateLimit(data.index);
            break;

        // Stats
        case 'stats-flush':
            copilotStore.flushApiCallCounts();
            credentialStore.flushApiCallCounts();
            relayStore.flushApiCallCounts();
            break;
        case 'stats-reset':
            if (data.service === 'copilot') copilotStore.resetCustomStats();
            else if (data.service === 'codebuddy') credentialStore.resetCustomStats();
            else if (data.service === 'relay') relayStore.resetCustomStats();
            else {
                copilotStore.resetCustomStats();
                credentialStore.resetCustomStats();
                relayStore.resetCustomStats();
            }
            break;

        default:
            logger.warn(`Unknown broadcast event type: ${type}`);
    }
}

export function createServer() {
    const server = http.createServer(async (req, res) => {
        // 只打印已知路由的请求日志，忽略遥测等无关请求
        const isKnown =
            req.url.startsWith('/login') ||
            req.url.startsWith('/logout') ||
            req.url.startsWith('/copilotFE') ||
            req.url.startsWith('/copilot/') ||
            req.url.startsWith('/copilot/anthropic/v1/') ||
            req.url.startsWith('/codebuddyFE') ||
            req.url.startsWith('/codebuddy/v1/') ||
            req.url.startsWith('/codebuddy/anthropic/v1/') ||
            req.url.startsWith('/relayFE') ||
            req.url.startsWith('/relay/v1/') ||
            req.url.startsWith('/relay/anthropic/v1/');
        if (isKnown) {
            logger.info(`${req.method} ${req.url}`);
        }

        // ============ 健康检查（无需鉴权，供监控探活） ============
        // 仅暴露布尔/计数/端口/版本，绝不含 token/凭证/密钥/明文用户名
        const healthPath = (req.url || '').split('?')[0];
        if (req.method === 'GET' && healthPath === '/health') {
            let relayTotal = 0;
            let relayEnabled = 0;
            try {
                const um = relayStore.getUpstreamManager();
                relayTotal = um.getCount();
                relayEnabled = um.getEnabledCount();
            } catch {
                // Relay 未初始化，按 0 处理
            }

            let codebuddyReady = false;
            try {
                codebuddyReady = credentialStore.hasCredentials();
            } catch {
                // 凭证存储未初始化
            }

            let copilotReady = false;
            try {
                copilotReady = isAuthenticated();
            } catch {
                // Copilot 状态未初始化
            }

            const backends = {
                copilot: {ready: copilotReady},
                codebuddy: {ready: codebuddyReady},
                relay: {ready: relayEnabled > 0, upstreams: relayTotal, enabled: relayEnabled}
            };
            const ready = copilotReady || codebuddyReady || relayEnabled > 0;

            sendJson(res, 200, {
                status: ready ? 'ok' : 'degraded',
                ready,
                uptime: Math.floor(process.uptime()),
                version: APP_VERSION,
                timestamp: Date.now(),
                cluster: {mode: isClusterMode(), port: getCurrentPort(), ports: getAllPorts()},
                maxPayloadBytes: MAX_PAYLOAD_BYTES,
                backends
            });
            return;
        }

        // ============ 单请求体体积上限 ============
        // 在解析前拦截超大请求，避免携带超长历史/大内联附件/高分辨率图片的请求挤占内存。
        // 默认 16MB，可用 MAX_PAYLOAD_BYTES 覆盖。仅对带请求体的方法生效。
        if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && MAX_PAYLOAD_BYTES > 0) {
            const lenHeader = req.headers['content-length'];
            const contentLength = lenHeader ? parseInt(lenHeader, 10) : 0;
            if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
                logger.warn(`请求体过大被拒: ${contentLength} > ${MAX_PAYLOAD_BYTES} (${req.method} ${req.url})`);
                const limitMb = (MAX_PAYLOAD_BYTES / (1024 * 1024)).toFixed(1);
                const payload = {
                    error: {
                        message: `请求体过大（${(contentLength / 1024 / 1024).toFixed(1)}MB > ${limitMb}MB 上限）`,
                        type: 'invalid_request_error',
                        code: 413,
                        gateway_hint: `如需放宽上限，请设置环境变量 MAX_PAYLOAD_BYTES（单位字节）后重启服务`
                    }
                };
                res.writeHead(413, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(payload));
                return;
            }
        }

        // ============ 鉴权路由 ============

        // POST /login — 处理登录请求
        if (req.method === 'POST' && req.url === '/login') {
            try {
                await handleLoginRequest(req, res);
                return;
            } catch (err) {
                logger.error('Login error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // GET /login — 登录页面
        if (req.method === 'GET' && req.url.startsWith('/login')) {
            try {
                if (req.url === '/login/public-key') {
                    getPublicKeyEndpoint(req, res);
                } else {
                    serveLoginPage(req, res);
                }
                return;
            } catch (err) {
                logger.error('Login page error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // GET/POST /logout — 登出
        if (req.url === '/logout') {
            try {
                handleLogoutRequest(req, res);
                return;
            } catch (err) {
                logger.error('Logout error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // POST /admin/clear-credentials — 清除账号密码，恢复免密登录（需已登录）
        if (req.method === 'POST' && req.url === '/admin/clear-credentials') {
            if (!requireAdminAuth(req, res)) return;
            try {
                handleClearCredentials(req, res);
                return;
            } catch (err) {
                logger.error('Clear credentials error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // POST /admin/set-credentials — 设置账号密码（需已登录）
        if (req.method === 'POST' && req.url === '/admin/set-credentials') {
            if (!requireAdminAuth(req, res)) return;
            try {
                await handleSetCredentials(req, res);
                return;
            } catch (err) {
                logger.error('Set credentials error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ============ 管理后台路由（需要管理员认证） ============

        // Copilot 前端管理界面（必须在 /copilot 通用路由之前）
        if (req.url.startsWith('/copilotFE')) {
            if (!requireAdminAuth(req, res)) return;
            try {
                await routeCopilotFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Copilot frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 前端管理界面
        if (req.url.startsWith('/codebuddyFE')) {
            if (!requireAdminAuth(req, res)) return;
            try {
                await routeCodebuddyFrontend(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 前端管理界面
        if (req.url.startsWith('/relayFE')) {
            if (!requireAdminAuth(req, res)) return;
            try {
                await routeRelayFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Relay frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ============ 内部通信端点（集群广播 + 统计聚合） ============

        if (req.url.startsWith('/internal/')) {
            // 仅允许本地访问
            const remoteAddr = req.socket.remoteAddress || '';
            if (!remoteAddr.includes('127.0.0.1') && !remoteAddr.includes('::1') && remoteAddr !== '::ffff:127.0.0.1') {
                res.writeHead(403, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: 'Forbidden'}));
                return;
            }

            // POST /internal/broadcast — 接收广播事件
            if (req.method === 'POST' && req.url === '/internal/broadcast') {
                try {
                    const chunks = [];
                    req.on('data', chunk => chunks.push(chunk));
                    req.on('end', () => {
                        try {
                            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            handleBroadcastEvent(data);
                            res.writeHead(200, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify({ok: true}));
                        } catch (err) {
                            res.writeHead(400, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify({error: err.message}));
                        }
                    });
                    return;
                } catch (err) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({error: err.message}));
                    return;
                }
            }

            // GET /internal/stats/{service} — 返回当前 worker 的统计数据
            const statsMatch = req.url.match(/^\/internal\/stats\/([a-z]+)$/);
            if (req.method === 'GET' && statsMatch) {
                const service = statsMatch[1];
                let stats = null;
                switch (service) {
                    case 'copilot':
                        stats = copilotStore.getUsageStats();
                        break;
                    case 'codebuddy':
                        stats = credentialStore.getUsageStats();
                        break;
                    case 'relay':
                        stats = relayStore.getUsageStats();
                        break;
                    default:
                        res.writeHead(404, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({error: 'Unknown service'}));
                        return;
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(stats));
                return;
            }

            // GET /internal/stats/daily/{service}?month=YYYY-MM — 返回当前 worker 的每日统计
            const dailyMatch = req.url.match(/^\/internal\/stats\/daily\/([a-z]+)$/);
            if (req.method === 'GET' && dailyMatch) {
                const service = dailyMatch[1];
                const urlObj = new URL(req.url, `http://${req.headers.host}`);
                const month = urlObj.searchParams.get('month') || '';
                let dailyData = null;
                switch (service) {
                    case 'copilot':
                        dailyData = copilotStore.getDailyUsageBuffer();
                        break;
                    case 'codebuddy':
                        dailyData = credentialStore.getDailyUsageBuffer();
                        break;
                    case 'relay':
                        dailyData = relayStore.getDailyUsageBuffer();
                        break;
                    default:
                        res.writeHead(404, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({error: 'Unknown service'}));
                        return;
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(dailyData));
                return;
            }

            res.writeHead(404, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Not found'}));
            return;
        }

        // ============ API 路由（需要网关令牌认证） ============

        // Copilot 路由
        if (req.url.startsWith('/copilot')) {
            if (!requireGatewayAuth(req, res)) return;
            try {
                await routeCopilotRequest(req, res);
                return;
            } catch (err) {
                logger.error('Copilot route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 路由
        if (req.url.startsWith('/codebuddy')) {
            if (!requireGatewayAuth(req, res)) return;
            try {
                await routeCodebuddyRequest(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 路由
        if (req.url.startsWith('/relay')) {
            if (!requireGatewayAuth(req, res)) return;
            try {
                await routeRelayRequest(req, res);
                return;
            } catch (err) {
                logger.error('Relay route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ============ 根路径（需要管理员认证） ============

        if (req.method === 'GET' && req.url === '/') {
            if (!requireAdminAuth(req, res)) return;
            const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WorkBuddy API Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 640px; width: 100%; padding: 48px 24px; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { color: #8b949e; margin-bottom: 40px; font-size: 0.95rem; }
    .cards { display: flex; flex-direction: column; gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px 24px; text-decoration: none; color: inherit; display: flex; align-items: center; justify-content: space-between; transition: border-color 0.2s, background 0.2s; }
    .card:hover { border-color: #58a6ff; background: #1c2230; }
    .card-info { display: flex; flex-direction: column; gap: 4px; }
    .card-title { font-size: 1rem; font-weight: 600; color: #f0f6fc; }
    .card-desc { font-size: 0.85rem; color: #8b949e; }
    .card-arrow { color: #58a6ff; font-size: 1.2rem; }
    .badge { display: inline-block; font-size: 0.72rem; padding: 2px 8px; border-radius: 20px; margin-top: 4px; background: #21262d; color: #79c0ff; border: 1px solid #388bfd44; }
    .logout-btn { display: inline-block; margin-top: 24px; padding: 8px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 8px; color: #8b949e; text-decoration: none; font-size: 0.85rem; transition: border-color 0.2s; }
    .logout-btn:hover { border-color: #f85149; color: #f85149; }
    .footer-actions { margin-top: 24px; display: flex; gap: 12px; }
    .danger-btn { display: inline-block; padding: 8px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 8px; color: #d29922; text-decoration: none; font-size: 0.85rem; cursor: pointer; transition: border-color 0.2s, color 0.2s; }
    .danger-btn:hover { border-color: #d29922; color: #f0b429; }
  </style>
</head>
<body>
  <div class="container">
    <h1>WorkBuddy API Proxy</h1>
    <p class="subtitle">统一管理 Copilot、CodeBuddy、Relay 三个代理服务</p>
    <div class="cards">
      <a class="card" href="/copilotFE">
        <div class="card-info">
          <span class="card-title">GitHub Copilot</span>
          <span class="card-desc">Copilot 账号管理与 API 代理</span>
          <span class="badge">/copilotFE &nbsp;·&nbsp; /copilot</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
      <a class="card" href="/codebuddyFE">
        <div class="card-info">
          <span class="card-title">CodeBuddy</span>
          <span class="card-desc">CodeBuddy 账号管理与 API 代理</span>
          <span class="badge">/codebuddyFE &nbsp;·&nbsp; /codebuddy</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
      <a class="card" href="/relayFE">
        <div class="card-info">
          <span class="card-title">Relay</span>
          <span class="card-desc">上游 LLM 中继代理</span>
          <span class="badge">/relayFE &nbsp;·&nbsp; /relay</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
    </div>
    <div class="footer-actions">
      <a class="logout-btn" href="/logout">登出</a>
      <button class="danger-btn" id="clearCredBtn" onclick="clearCredentials()" style="display:none;">清除账号密码（恢复免密登录）</button>
      <button class="danger-btn" id="setCredBtn" onclick="setCredentials()" style="display:none;">设置账号密码</button>
    </div>
  </div>

  <!-- 设置账号密码弹窗 -->
  <div id="setCredModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;z-index:1000;">
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:400px;width:90%;">
      <h3 style="margin:0 0 16px;font-size:1.1rem;color:#f0f6fc;">设置账号密码</h3>
      <div id="setCredError" style="display:none;padding:8px 12px;background:#3d1418;border:1px solid #6e2b2f;border-radius:6px;color:#f85149;font-size:0.85rem;margin-bottom:12px;"></div>
      <label style="display:block;font-size:0.85rem;color:#8b949e;margin-bottom:4px;">用户名</label>
      <input type="text" id="setCredUser" value="admin" style="width:100%;padding:8px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:0.9rem;margin-bottom:12px;outline:none;">
      <label style="display:block;font-size:0.85rem;color:#8b949e;margin-bottom:4px;">密码</label>
      <input type="password" id="setCredPass" placeholder="输入密码" style="width:100%;padding:8px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:0.9rem;margin-bottom:8px;outline:none;">
      <label style="display:block;font-size:0.85rem;color:#8b949e;margin-bottom:4px;">确认密码</label>
      <input type="password" id="setCredPass2" placeholder="再次输入密码" style="width:100%;padding:8px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:0.9rem;margin-bottom:20px;outline:none;">
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="logout-btn" style="margin-top:0;" onclick="closeSetCredModal()">取消</button>
        <button class="danger-btn" onclick="submitSetCredentials()">确定设置</button>
      </div>
    </div>
  </div>

  <script>
    // 有密码 -> 显示"清除"；无密码 -> 显示"设置"
    (function () {
      var enabled = ${isAdminAuthEnabled() ? 'true' : 'false'};
      var btn = document.getElementById(enabled ? 'clearCredBtn' : 'setCredBtn');
      if (btn) btn.style.display = 'inline-block';
    })();

    async function clearCredentials() {
      if (!confirm('确定要清除账号密码吗？\\n清除后将恢复免密登录，任何访问者都能直接进入管理面板。')) return;
      try {
        var resp = await fetch('/admin/clear-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        var data = await resp.json();
        if (resp.ok) {
          alert(data.message || '已清除，恢复免密登录');
          location.reload();
        } else {
          alert(data.error || '清除失败');
        }
      } catch (e) {
        alert('请求失败: ' + e.message);
      }
    }

    function setCredentials() {
      document.getElementById('setCredError').style.display = 'none';
      document.getElementById('setCredPass').value = '';
      document.getElementById('setCredPass2').value = '';
      document.getElementById('setCredModal').style.display = 'flex';
    }

    function closeSetCredModal() {
      document.getElementById('setCredModal').style.display = 'none';
    }

    async function submitSetCredentials() {
      var user = document.getElementById('setCredUser').value.trim() || 'admin';
      var pass = document.getElementById('setCredPass').value;
      var pass2 = document.getElementById('setCredPass2').value;
      var errEl = document.getElementById('setCredError');
      if (!pass) { errEl.textContent = '密码不能为空'; errEl.style.display = 'block'; return; }
      if (pass !== pass2) { errEl.textContent = '两次输入的密码不一致'; errEl.style.display = 'block'; return; }
      try {
        var resp = await fetch('/admin/set-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
        var data = await resp.json();
        if (resp.ok) {
          alert(data.message || '设置成功，下次访问需登录');
          location.reload();
        } else {
          errEl.textContent = data.error || '设置失败';
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.textContent = '请求失败: ' + e.message;
        errEl.style.display = 'block';
      }
    }
  </script>
</body>
</html>`;
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(html);
            return;
        }

        send404(req, res);
    });

    // ============ WebSocket 升级处理 ============

    const wss = new WebSocketServer({noServer: true});

    // 禁用 Nagle 算法：Node 默认启用 Nagle，会把小写入攒着等前一个包的 ACK，
    // 碰上客户端 delayed ACK 时每个小响应白付 ~40ms。SSE 逐块写出与管理面板小 JSON 都受益。
    server.on('connection', (socket) => socket.setNoDelay(true));

    // 服务端级错误处理 — 防止未捕获的 socket 错误导致进程崩溃
    server.on('error', (err) => {
        logger.error(`Server error: ${err.message}`, err.stack);
        // EADDRINUSE 等致命错误仍然需要退出
        if (err.code === 'EADDRINUSE') {
            console.error(`Port already in use, exiting...`);
            process.exit(1);
        }
    });

    server.on('clientError', (err, socket) => {
        logger.warn(`Client error: ${err.message}`);
        // 对畸形请求直接关闭 socket，避免资源泄露
        if (socket && !socket.destroyed) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
    });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        logger.info(`WS upgrade: ${pathname}`);

        // WS 鉴权
        if (!requireGatewayAuthWS(req)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // WS 和 HTTP 使用同一个 URL，通过 upgrade 事件区分
        // POST /xxx/v1/responses → HTTP handler（上面已处理）
        // WS Upgrade /xxx/v1/responses → WS handler（下面处理）
        if (pathname === '/copilot/v1/responses') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleCopilotResponsesWS(ws, req);
            });
        } else if (pathname === '/relay/v1/responses') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleRelayResponsesWS(ws, req);
            });
        } else if (pathname === '/codebuddy/v1/responses') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleCodebuddyResponsesWS(ws, req);
            });
        } else {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
        }
    });

    return server;
}
