/**
 * Relay 前端管理界面路由
 * 提供 Web UI 用于上游配置和用量统计
 * 支持登录鉴权模式
 * @module routes/relay-frontend
 */

import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import logger from '../utils/logger.js';
import {relayStore} from '../services/relay/relay-store.js';
import {getGatewayApiKeyInfo, regenerateGatewayToken} from '../services/gateway/auth.js';
import {buildUrl} from '../utils/helpers.js';
import {gatherAllStats, broadcast} from '../utils/cluster-broadcaster.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');

function readTemplate(name) {
    return readFileSync(join(templatesDir, name), 'utf8');
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 读取请求体并解析为 JSON
 */
function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

/**
 * 获取状态信息
 */
async function handleStatus(req, res) {
    const um = relayStore.getUpstreamManager();
    const apiInfo = getGatewayApiKeyInfo();
    const usage = await gatherAllStats('relay');
    const upstreams = um.listUpstreams();
    sendJson(res, 200, {
        upstreamCount: upstreams.length,
        enabledCount: upstreams.filter(u => u.enabled !== false).length,
        apiKeyPrefix: apiInfo.prefix,
        apiKeyPlain: apiInfo.apiKeyPlain,
        usage
    });
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
        logger.error('Relay 重新生成 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 列出上游配置
 */
function handleListUpstreams(req, res) {
    try {
        const manager = relayStore.getUpstreamManager();
        const upstreams = manager.listUpstreams();
        sendJson(res, 200, {upstreams});
    } catch (error) {
        logger.error('Relay 列出上游配置失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 添加上游配置
 */
async function handleAddUpstream(req, res) {
    try {
        const manager = relayStore.getUpstreamManager();
        const data = await readRequestBody(req);
        const result = manager.addUpstream({
            name: data.name,
            base_url: data.base_url,
            api_key: data.api_key,
            proxy: data.proxy,
            skip_tls_verify: data.skip_tls_verify,
            models: data.models,
            model_map: data.model_map,
            protocol: data.protocol,
            ws: data.ws
        });
        sendJson(res, 200, {message: '上游配置添加成功', upstream: result});
    } catch (error) {
        logger.error('Relay 添加上游配置失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 编辑上游配置
 */
async function handleUpdateUpstream(req, res, index) {
    try {
        const manager = relayStore.getUpstreamManager();
        const data = await readRequestBody(req);
        const result = manager.updateUpstream(index, data);
        if (result) {
            sendJson(res, 200, {message: '上游配置更新成功', upstream: result});
        } else {
            sendJson(res, 400, {error: '无效的上游索引'});
        }
    } catch (error) {
        logger.error('Relay 编辑上游配置失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 删除上游配置
 */
function handleDeleteUpstream(req, res, index) {
    try {
        const manager = relayStore.getUpstreamManager();
        const success = manager.deleteUpstream(index);
        if (success) {
            sendJson(res, 200, {message: '上游配置删除成功'});
        } else {
            sendJson(res, 400, {error: '无效的上游索引'});
        }
    } catch (error) {
        logger.error('Relay 删除上游配置失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 复制上游配置
 */
async function handleCloneUpstream(req, res, index) {
    try {
        const manager = relayStore.getUpstreamManager();
        const upstreams = manager.listUpstreams();
        if (index < 0 || index >= upstreams.length) {
            return sendJson(res, 400, {error: '无效的上游索引'});
        }
        const source = upstreams[index];
        const clone = {
            name: `${source.name || '未命名'} (副本)`,
            base_url: source.base_url,
            api_key: source.api_key_full || source.api_key,
            proxy: source.proxy,
            skip_tls_verify: source.skip_tls_verify,
            models: source.models ? [...source.models] : undefined,
            model_map: source.model_map ? {...source.model_map} : undefined,
            protocol: source.protocol,
            ws: source.ws
        };
        const result = manager.addUpstream(clone);
        sendJson(res, 200, {message: '上游配置复制成功', upstream: result});
    } catch (error) {
        logger.error('Relay 复制上游配置失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 测试上游连通性
 */
async function handleTestUpstream(req, res) {
    try {
        const manager = relayStore.getUpstreamManager();
        const {index} = await readRequestBody(req);
        if (index === undefined || index === null) {
            return sendJson(res, 400, {error: 'index is required'});
        }
        const result = await manager.testUpstream(index);
        sendJson(res, 200, result);
    } catch (error) {
        logger.error('Relay 测试上游连通性失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 从上游获取模型列表（用于前端配置时加载）
 */
async function handleFetchUpstreamModels(req, res) {
    try {
        const {base_url, api_key, proxy, skip_tls_verify} = await readRequestBody(req);
        if (!base_url || !api_key) {
            return sendJson(res, 400, {error: 'base_url 和 api_key 为必填'});
        }
        const {request, readBody} = await import('../utils/http-client.js');
        const {HttpsProxyAgent} = await import('https-proxy-agent');
        const {SocksProxyAgent} = await import('socks-proxy-agent');

        const rejectUnauthorized = skip_tls_verify !== true;
        const headers = {
            'Authorization': `Bearer ${api_key}`,
            'Accept': 'application/json',
            'User-Agent': 'Relay/1.0'
        };
        const options = {method: 'GET', headers, timeout: 15000, rejectUnauthorized};

        if (proxy) {
            const agentOptions = {rejectUnauthorized};
            options.agent = proxy.startsWith('socks')
                ? new SocksProxyAgent(proxy, agentOptions)
                : new HttpsProxyAgent(proxy, agentOptions);
        }

        const url = buildUrl(base_url, 'v1/models');

        try {
            const response = await request(url, options);
            if (response.status >= 200 && response.status < 300) {
                const body = await readBody(response.body);
                const data = JSON.parse(body);
                const models = (data.data || []).map(m => m.id).filter(Boolean);
                return sendJson(res, 200, {success: true, models});
            }
            const body = await readBody(response.body);
            sendJson(res, 200, {success: false, message: `上游返回 HTTP ${response.status}: ${body.slice(0, 200)}`});
        } catch (err) {
            sendJson(res, 200, {success: false, message: err.message});
        }
    } catch (error) {
        sendJson(res, 200, {success: false, message: error.message});
    }
}

/**
 * 设置活跃上游
 */
async function handleSetActiveUpstream(req, res) {
    try {
        const manager = relayStore.getUpstreamManager();
        const {index} = await readRequestBody(req);
        if (index === undefined || index === null) {
            return sendJson(res, 400, {error: 'index is required'});
        }
        const success = manager.setActiveUpstream(index);
        if (success) {
            sendJson(res, 200, {success: true, message: '活跃上游已设置'});
        } else {
            sendJson(res, 400, {error: '无效的上游索引或该上游未启用'});
        }
    } catch (error) {
        logger.error('Relay 设置活跃上游失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 重置单个上游的限速冷却状态
 */
async function handleResetUpstreamRateLimit(req, res) {
    try {
        const manager = relayStore.getUpstreamManager();
        const {index} = await readRequestBody(req);
        if (index === undefined || index === null) {
            return sendJson(res, 400, {error: 'index is required'});
        }
        const result = manager.resetRateLimit(index);
        if (!result.ok) {
            return sendJson(res, 400, {error: '无效的上游索引'});
        }
        // 通知其他 worker 同步清除该 index 的冷却
        broadcast('relay-ratelimit-reset', {index}).catch(() => {});
        sendJson(res, 200, {
            message: result.wasRateLimited
                ? `上游 #${index + 1} 的冷却状态已重置`
                : `上游 #${index + 1} 当前未处于冷却状态`,
            reset: result.wasRateLimited,
            broadcasted: true
        });
    } catch (error) {
        logger.error('Relay 重置上游冷却失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 管理面板 HTML
 */
function serveAdminPage(res) {
    const html = readTemplate('relay-admin.html');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}

/**
 * 主路由处理函数
 */
export async function routeRelayFrontend(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 主页面 ==========
    if (pathname === '/relayFE' || pathname === '/relayFE/') {
        return serveAdminPage(res);
    }

    // 状态信息
    if (pathname === '/relayFE/status' && method === 'GET') {
        return handleStatus(req, res);
    }

    // 重新生成 API Key
    if (pathname === '/relayFE/regenerate-key' && method === 'POST') {
        return handleRegenerateApiKey(req, res);
    }

    // ===== 上游配置管理 =====

    // 列出上游配置
    if (pathname === '/relayFE/upstreams' && method === 'GET') {
        return handleListUpstreams(req, res);
    }

    // 添加上游配置
    if (pathname === '/relayFE/upstreams' && method === 'POST') {
        return handleAddUpstream(req, res);
    }

    // 上游配置子路由（带 index）
    const upstreamIndexMatch = pathname.match(/^\/relayFE\/upstreams\/(\d+)$/);
    if (upstreamIndexMatch) {
        const index = parseInt(upstreamIndexMatch[1], 10);

        // 编辑上游配置
        if (method === 'PUT') {
            return handleUpdateUpstream(req, res, index);
        }

        // 删除上游配置
        if (method === 'DELETE') {
            return handleDeleteUpstream(req, res, index);
        }
    }

    // 复制上游配置
    const upstreamCloneMatch = pathname.match(/^\/relayFE\/upstreams\/(\d+)\/clone$/);
    if (upstreamCloneMatch && method === 'POST') {
        const cloneIndex = parseInt(upstreamCloneMatch[1], 10);
        return handleCloneUpstream(req, res, cloneIndex);
    }

    // 测试上游连通性
    if (pathname === '/relayFE/upstreams/test' && method === 'POST') {
        return handleTestUpstream(req, res);
    }

    // 获取上游模型列表（配置时使用）
    if (pathname === '/relayFE/upstreams/fetch-models' && method === 'POST') {
        return handleFetchUpstreamModels(req, res);
    }

    // 设置活跃上游
    if (pathname === '/relayFE/upstreams/set-active' && method === 'POST') {
        return handleSetActiveUpstream(req, res);
    }

    // 重置上游冷却状态
    if (pathname === '/relayFE/upstreams/reset-ratelimit' && method === 'POST') {
        return handleResetUpstreamRateLimit(req, res);
    }

    // ===== 使用量统计 =====

    // 刷新统计数据
    if (pathname === '/relayFE/stats/refresh' && method === 'POST') {
        await broadcast('stats-flush');
        relayStore.flushApiCallCounts();
        const usage = await gatherAllStats('relay');
        return sendJson(res, 200, {message: '数据已刷新', usage});
    }

    // 重置自定义统计数据
    if (pathname === '/relayFE/stats/custom-reset' && method === 'POST') {
        relayStore.resetCustomStats();
        await broadcast('stats-reset', {service: 'relay'});
        const usage = await gatherAllStats('relay');
        return sendJson(res, 200, {message: '自定义统计数据已重置', usage});
    }

    // 获取每日使用数据
    if (pathname === '/relayFE/stats/daily' && method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const month = urlObj.searchParams.get('month') || '';
        if (!month) {
            return sendJson(res, 400, {error: '缺少 month 参数'});
        }
        const dailyData = relayStore.getDailyUsage(month);
        return sendJson(res, 200, {month, data: dailyData});
    }

    // 获取使用量统计
    if (pathname === '/relayFE/stats' && method === 'GET') {
        const usage = await gatherAllStats('relay');
        return sendJson(res, 200, usage);
    }

    // 404
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Not found'}));
}
