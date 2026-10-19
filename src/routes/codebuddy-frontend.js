/**
 * CodeBuddy 前端管理界面路由
 * 提供 Web UI 用于 OAuth2 认证和凭证管理
 * 支持登录鉴权模式 - 单租户
 * @module routes/codebuddy-frontend
 */

import {randomUUID, randomBytes} from 'crypto';
import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {execFile} from 'child_process';
import logger from '../utils/logger.js';
import {credentialStore} from '../services/codebuddy/credential-store.js';
import {queryAllBillingStatus, performCheckin, getStartupCheckinConfig, setStartupCheckinConfig, getScheduleState} from '../services/codebuddy/billing.js';
import {queryGrowthOverview, runGrowthDaily, getGrowthCredentials} from '../services/codebuddy/growth.js';
import {getModelPricing, pickCredentialPerRealm} from '../services/codebuddy/api.js';
import {getGatewayApiKeyInfo, regenerateGatewayToken} from '../services/gateway/auth.js';
import {getCodebuddyBaseUrl, getCodebuddyBaseUrlOptions, getEnterpriseBaseUrls, BLOCKED_DOMAINS, isPersonalHost, CODEBUDDY_CLI_VERSION, VENDOR_META, VENDOR_ORDER} from '../services/codebuddy/config.js';
import {gatherAllStats, broadcast, isClusterMode, getCurrentPort} from '../utils/cluster-broadcaster.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');

function readTemplate(name) {
    return readFileSync(join(templatesDir, name), 'utf8');
}

/**
 * 只读查询一个 Windows 计划任务的状态（返回 null 表示未注册或查询失败）
 * 非 Windows 平台或未注册时静默返回 null，不影响接口。
 * @param {string} taskName
 * @returns {Promise<Object|null>}
 */
function queryScheduledTask(taskName) {
    return new Promise((resolve) => {
        execFile('schtasks', ['/query', '/tn', taskName, '/fo', 'csv', '/nh'], {windowsHide: true}, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const line = stdout.trim().split('\n')[0] || '';
            const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
            // CSV 列：TaskName, Next Run Time, Status, Logon Mode, Last Run Time, Last Result, ...
            resolve({
                registered: true,
                nextRunTime: cols[1] || null,
                status: cols[2] || null,
                lastRunTime: cols[4] || null,
                lastResult: cols[5] || null
            });
        });
    });
}

// 认证状态存储 (简化版，生产环境应使用 Redis 等)
const authStates = new Map();
const AUTH_STATE_TTL = 30 * 60 * 1000; // 30 分钟过期

/**
 * 清理过期的认证状态，防止内存泄漏
 */
function cleanupExpiredAuthStates() {
    const now = Date.now();
    for (const [key, value] of authStates.entries()) {
        if (now - value.createdAt > AUTH_STATE_TTL) {
            authStates.delete(key);
        }
    }
}

// 每 10 分钟清理一次过期认证状态
setInterval(cleanupExpiredAuthStates, 10 * 60 * 1000).unref();

// CodeBuddy OAuth2 端点（根据传入 base_url 动态构建）
function getBaseUrl(customUrl) {
    return getCodebuddyBaseUrl(customUrl);
}

function getAuthStateEndpoint(customUrl) {
    return `${getBaseUrl(customUrl)}/v2/plugin/auth/state`;
}

function getAuthTokenEndpoint(customUrl) {
    return `${getBaseUrl(customUrl)}/v2/plugin/auth/token`;
}

/**
 * 生成请求头
 */
function getAuthStartHeaders(customUrl) {
    const requestId = randomUUID().replace(/-/g, '');
    const baseUrl = getBaseUrl(customUrl);
    const host = new URL(baseUrl).host;
    return {
        Host: host,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': host,
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'User-Agent': `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
        'X-Product': 'SaaS',
        'X-Request-ID': requestId
    };
}

function getAuthPollHeaders(customUrl) {
    const requestId = randomUUID().replace(/-/g, '');
    const spanId = randomBytes(8).toString('hex');
    const baseUrl = getBaseUrl(customUrl);
    const host = new URL(baseUrl).host;
    return {
        Host: host,
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Request-ID': requestId,
        b3: `${requestId}-${spanId}-1-`,
        'X-B3-TraceId': requestId,
        'X-B3-ParentSpanId': '',
        'X-B3-SpanId': spanId,
        'X-B3-Sampled': '1',
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'X-Domain': host,
        'User-Agent': `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
        'X-Product': 'SaaS'
    };
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 获取状态信息（替代 handleMyTenant）
 */
async function handleStatus(req, res) {
    const tm = credentialStore.getTokenManager();
    const apiInfo = getGatewayApiKeyInfo();
    const usage = await gatherAllStats('codebuddy');
    sendJson(res, 200, {
        hasCredentials: tm.hasCredentials(),
        credentialCount: tm.credentials?.length || 0,
        apiKeyPrefix: apiInfo.prefix,
        apiKeyPlain: apiInfo.apiKeyPlain,
        manualSelectedIndex: tm.manualSelectedIndex,
        usage,
        cluster: {mode: isClusterMode(), port: getCurrentPort()}
    });
}

/**
 * 获取模型列表（含倍率、上下文窗口、能力标签），供管理面板"可用模型"展示
 *
 * 国内站与国际站的模型集合和倍率都不同，所以要**按站点分别拉取**。
 * 之前只取 peekCredential() 一个号，面板上永远只有某一个站点的模型。
 *
 * 每个站点取一个代表账号（只读取号，不推进轮换计数）；某站点拉取失败时
 * 单独标记该站点的 fromCache，不影响另一个站点。
 */
async function handleModels(req, res) {
    const tm = credentialStore.getTokenManager();

    // 按站点挑代表账号（同一站点有多个号时取第一个，够用了）
    const targets = pickCredentialPerRealm(tm.credentials);

    if (targets.length === 0) {
        return sendJson(res, 200, {models: [], error: 'no_credentials'});
    }

    const realms = [];
    // 并发拉取两个站点，任一失败只影响自己那一组
    await Promise.all(
        targets.map(async ({realm, credential}) => {
            try {
                const models = await getModelPricing(credential);
                realms.push({
                    realm,
                    models: Array.isArray(models) ? models : [],
                    fromCache: models._fromCache === true,
                    error: null
                });
            } catch (error) {
                logger.error(`获取${realm}模型列表失败:`, error.message);
                realms.push({realm, models: [], fromCache: false, error: error.message});
            }
        })
    );

    // 固定展示顺序：国内站在前
    const order = {cn: 0, intl: 1};
    realms.sort((a, b) => (order[a.realm] ?? 9) - (order[b.realm] ?? 9));

    // 平铺数组保留给不认识 realms 的调用方；realms 是给面板分组用的
    const models = realms.flatMap((r) => r.models);
    // 厂商展示名与顺序一并下发，面板不再自己维护一份
    const vendorLabels = {};
    for (const key of VENDOR_ORDER) vendorLabels[key] = VENDOR_META[key].label;
    sendJson(res, 200, {models, realms, vendorLabels, vendorOrder: VENDOR_ORDER});
}

/**
 * 重新生成 API Key（网关令牌，影响所有端点）
 */
function handleRegenerateApiKey(req, res) {
    try {
        const apiKey = regenerateGatewayToken();
        if (apiKey) {
            sendJson(res, 200, {
                message: 'API Key 已重新生成，新 Key 仅显示一次！重置将同时影响所有端点（Copilot/CodeBuddy/Relay）',
                api_key: apiKey
            });
        } else {
            sendJson(res, 400, {error: '重新生成失败'});
        }
    } catch (error) {
        logger.error('重新生成 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 凭证操作（list/delete/select/toggle-disable）
 */
function handleCredentials(req, res, action) {
    const manager = credentialStore.getTokenManager();

    try {
        switch (action) {
            case 'list': {
                const credentials = manager.getCredentialsInfo();
                const rotation = manager.getRotationInfo();
                sendJson(res, 200, {credentials, rotation});
                break;
            }
            case 'delete': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const {index} = data;
                        if (index === undefined || index === null) {
                            sendJson(res, 400, {error: 'index is required'});
                            return;
                        }
                        const success = manager.deleteCredential(index);
                        if (success) {
                            sendJson(res, 200, {message: '凭证删除成功'});
                        } else {
                            sendJson(res, 400, {error: '删除失败，无效的索引'});
                        }
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            case 'select': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const {index} = data;
                        const success = manager.setManualCredential(index);
                        if (success) {
                            sendJson(res, 200, {message: `凭证 #${index + 1} 已手动选择`});
                        } else {
                            sendJson(res, 400, {error: '无效的索引'});
                        }
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            case 'reorder': {
                // 拖动排序结果：传文件名数组（稳定键），不传下标
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const order = Array.isArray(data.order) ? data.order : null;
                        if (!order) {
                            sendJson(res, 400, {error: 'order 必须是文件名数组'});
                            return;
                        }
                        const success = manager.setPriorityOrder(order);
                        if (success) {
                            sendJson(res, 200, {
                                message: '优先级已保存，下一个请求起按新顺序选号'
                            });
                        } else {
                            sendJson(res, 400, {error: '没有匹配的凭证'});
                        }
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            case 'priority-clear': {
                manager.clearPriorityOrder();
                sendJson(res, 200, {message: '已恢复自动轮转'});
                break;
            }
            case 'toggle-disable': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const {index} = data;
                        if (index === undefined || index === null) {
                            sendJson(res, 400, {error: 'index is required'});
                            return;
                        }
                        const result = manager.toggleCredentialDisable(index);
                        sendJson(res, 200, {
                            message: `凭证 #${index + 1} 已${result.disabled ? '禁用' : '启用'}`,
                            disabled: result.disabled
                        });
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            case 'reset-ratelimit': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body || '{}');
                        const {index, clearDisabled} = data;
                        if (index === undefined || index === null) {
                            sendJson(res, 400, {error: 'index is required'});
                            return;
                        }
                        const result = manager.resetRateLimit(index, {clearDisabled: clearDisabled === true});
                        if (!result.ok) {
                            sendJson(res, 400, {error: '无效的凭证索引'});
                            return;
                        }
                        // 通知其他 worker 同步清除该 index 的冷却
                        broadcast('codebuddy-ratelimit-reset', {index, clearDisabled: clearDisabled === true}).catch(() => {});
                        const parts = [];
                        if (result.wasRateLimited) parts.push('冷却');
                        if (result.wasDisabled) parts.push('禁用');
                        const message = parts.length > 0
                            ? `凭证 #${index + 1} 的${parts.join('与')}状态已重置`
                            : `凭证 #${index + 1} 当前无需重置`;
                        sendJson(res, 200, {
                            message,
                            reset: result.wasRateLimited,
                            wasDisabled: result.wasDisabled,
                            broadcasted: true
                        });
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            default:
                sendJson(res, 400, {error: 'Unknown action'});
        }
    } catch (error) {
        logger.error(`凭证操作失败 (${action}):`, error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * OAuth2 认证启动
 */
async function handleAuthStart(req, res) {
    try {
        // 从查询参数读取 base_url
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const baseUrl = getCodebuddyBaseUrl(urlObj.searchParams.get('base_url'));

        // 阻止使用已废弃域名
        const requestedHost = new URL(baseUrl).host;
        if (BLOCKED_DOMAINS.includes(requestedHost)) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: `域名 ${requestedHost} 已废弃，不允许添加凭证`}));
            return;
        }

        logger.info(`启动 CodeBuddy OAuth2 认证流程 (base_url: ${baseUrl})...`);

        const nonce = randomBytes(8).toString('hex');

        const stateUrl = `${getAuthStateEndpoint(baseUrl)}?platform=CLI&nonce=${nonce}`;
        const payload = JSON.stringify({nonce});

        const response = await fetch(stateUrl, {
            method: 'POST',
            headers: getAuthStartHeaders(baseUrl),
            body: payload
        });

        if (!response.ok) {
            throw new Error(`Auth state endpoint returned ${response.status}`);
        }

        const result = await response.json();

        if (result.code === 0 && result.data) {
            const {state, authUrl} = result.data;

            if (state && authUrl) {
                // 存储认证状态，标记 base_url
                authStates.set(state, {
                    createdAt: Date.now(),
                    status: 'pending',
                    baseUrl: baseUrl
                });

                logger.info(`认证流程启动成功, state: ${state.slice(0, 16)}...`);

                return sendJson(res, 200, {
                    success: true,
                    auth_state: state,
                    verification_uri_complete: authUrl,
                    verification_uri: getBaseUrl(baseUrl),
                    expires_in: 1800,
                    interval: 5,
                    status: 'awaiting_login',
                    message: '请使用提供的链接登录 CodeBuddy'
                });
            }
        }

        throw new Error('Invalid response from auth state endpoint');
    } catch (error) {
        logger.error('启动认证失败:', error);

        const isTlsError =
            error.message &&
            (error.message.includes('CA certificate key too weak') ||
                error.message.includes('unable to verify') ||
                error.message.includes('certificate') ||
                error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                error.code === 'CERT_HAS_EXPIRED');

        if (isTlsError) {
            sendJson(res, 500, {
                success: false,
                error: 'tls_error',
                message: 'TLS 证书验证失败: ' + error.message,
                hint: '可以尝试设置环境变量 NODE_TLS_REJECT_UNAUTHORIZED=0 来跳过证书验证（仅用于开发测试）'
            });
        } else {
            sendJson(res, 500, {
                success: false,
                error: 'auth_start_failed',
                message: error.message
            });
        }
    }
}

/**
 * OAuth2 轮询
 */
async function handleAuthPoll(req, res) {
    try {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(body);
        const {auth_state} = data;

        if (!auth_state) {
            return sendJson(res, 400, {
                error: 'missing_parameters',
                error_description: '缺少必要参数: auth_state'
            });
        }

        const authStateRecord = authStates.get(auth_state);
        const pollBaseUrl = getCodebuddyBaseUrl(authStateRecord?.baseUrl);
        const url = `${getAuthTokenEndpoint(pollBaseUrl)}?state=${auth_state}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: getAuthPollHeaders(pollBaseUrl)
        });

        if (!response.ok) {
            throw new Error(`Token endpoint returned ${response.status}`);
        }

        const result = await response.json();

        if (result.code === 11217) {
            return sendJson(res, 200, {
                status: 'pending',
                message: result.msg || '等待用户登录...',
                code: result.code
            });
        } else if (result.code === 0 && result.data?.accessToken) {
            const tokenData = result.data;

            let userId = 'unknown';
            let userInfo = {};

            try {
                const bearerToken = tokenData.accessToken;
                if (bearerToken && bearerToken.includes('.')) {
                    const parts = bearerToken.split('.');
                    if (parts.length >= 2) {
                        let payloadPart = parts[1];
                        const missingPadding = payloadPart.length % 4;
                        if (missingPadding) {
                            payloadPart += '='.repeat(4 - missingPadding);
                        }
                        const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));

                        userId = payload.email || payload.preferred_username || payload.sub || 'unknown';
                        userInfo = {
                            sub: payload.sub,
                            email: payload.email,
                            preferred_username: payload.preferred_username,
                            name: payload.name,
                            scope: payload.scope,
                            session_state: payload.sid
                        };
                        Object.keys(userInfo).forEach((key) => {
                            if (userInfo[key] === undefined) delete userInfo[key];
                        });

                        // 企业版检测：从 JWT iss 字段提取 enterpriseId
                        // 官方逻辑：iss 格式为 https://xxx/auth/realms/sso-{enterpriseId}
                        // 个人版 iss 不含 sso- 前缀
                        if (payload.iss) {
                            const lastItem = payload.iss.split('/').pop();
                            if (lastItem && lastItem.startsWith('sso-')) {
                                userInfo.enterprise_id = lastItem.slice(4);
                            }
                        }
                        // 兜底：从 realm_access.roles 的 ent-member:xxx 提取
                        if (!userInfo.enterprise_id && payload.realm_access?.roles) {
                            const entRole = payload.realm_access.roles.find(r => r.startsWith('ent-member:'));
                            if (entRole) {
                                userInfo.enterprise_id = entRole.slice('ent-member:'.length);
                            }
                        }
                    }
                }
            } catch (e) {
                logger.warn('JWT 解析失败:', e.message);
            }

            // 企业版：获取完整 account 信息（含 departmentFullName、enterpriseName）
            // 即使 JWT 未提取到 enterprise_id，只要不是个人版域名，就应尝试获取企业信息
            let accountInfo = {};
            const isEnterprise = !isPersonalHost(new URL(getBaseUrl(pollBaseUrl)).host);
            if (userInfo.enterprise_id || isEnterprise) {
                try {
                    const accountUrl = `${getBaseUrl(pollBaseUrl)}/v2/plugin/login/account?state=${auth_state}`;
                    const accountHost = new URL(getBaseUrl(pollBaseUrl)).host;
                    const accountResp = await fetch(accountUrl, {
                        method: 'GET',
                        headers: {
                            Host: accountHost,
                            Accept: 'application/json',
                            Authorization: `Bearer ${tokenData.accessToken}`,
                            'X-Domain': tokenData.domain || accountHost,
                            'X-No-User-Id': 'true',
                            'X-No-Enterprise-Id': 'true',
                            'X-No-Department-Info': 'true',
                            'X-Requested-With': 'XMLHttpRequest',
                            'User-Agent': `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`
                        }
                    });
                    if (accountResp.ok) {
                        const accountResult = await accountResp.json();
                        if (accountResult.code === 0 && accountResult.data) {
                            accountInfo = accountResult.data;
                            logger.info(`获取企业 account 信息成功: enterpriseId=${accountInfo.enterpriseId || userInfo.enterprise_id}`);
                        } else {
                            logger.warn(`获取企业 account 信息返回非0: code=${accountResult.code}, msg=${accountResult.msg}, url=${accountUrl}`);
                        }
                    } else {
                        logger.warn(`获取企业 account 信息请求失败: status=${accountResp.status}, url=${accountUrl}`);
                    }
                } catch (e) {
                    logger.warn('获取企业 account 信息失败:', e.message);
                }
            }

            const credentialData = {
                bearer_token: tokenData.accessToken,
                user_id: userId,
                base_url: pollBaseUrl,
                created_at: Math.floor(Date.now() / 1000),
                expires_in: tokenData.expiresIn,
                refresh_token: tokenData.refreshToken,
                token_type: tokenData.tokenType || 'Bearer',
                scope: tokenData.scope,
                domain: tokenData.domain,
                session_state: tokenData.sessionState,
                enterprise_id: accountInfo.enterpriseId || userInfo.enterprise_id || '',
                enterprise_name: accountInfo.enterpriseName || '',
                department_info: accountInfo.departmentFullName || '',
                user_info: userInfo,
                account_info: accountInfo,
                full_response: result
            };

            const filename = `codebuddy_${userId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20)}_${Date.now()}.json`;

            // 保存到 credentialStore's token manager
            const tm = credentialStore.getTokenManager();
            const saved = tm.addCredentialWithData(credentialData, filename);

            if (saved) {
                logger.info(`认证成功，用户: ${userId}`);
            } else {
                logger.error('凭证保存失败');
            }

            authStates.delete(auth_state);

            return sendJson(res, 200, {
                status: 'success',
                message: '认证成功！',
                saved,
                user_info: {
                    user_id: userId,
                    email: userInfo.email,
                    name: userInfo.name
                }
            });
        } else {
            return sendJson(res, 400, {
                status: 'error',
                message: result.msg || '认证失败',
                code: result.code
            });
        }
    } catch (error) {
        logger.error('轮询认证状态失败:', error);
        sendJson(res, 500, {
            status: 'error',
            message: error.message
        });
    }
}

/**
 * 管理面板 HTML
 */
function serveAdminPage(res) {
    let html = readTemplate('codebuddy-admin.html');
    const enterpriseUrls = getEnterpriseBaseUrls();
    const enterpriseSet = new Set(enterpriseUrls);
    const DOMESTIC_URL = 'https://copilot.tencent.com';
    const INTERNATIONAL_URL = 'https://www.codebuddy.ai';

    // 按顺序：国内站 → 国际站 → 企业站
    const ordered = [
        {url: DOMESTIC_URL, label: 'copilot.tencent.com（国内站）'},
        {url: INTERNATIONAL_URL, label: 'www.codebuddy.ai（国际站）'},
        ...enterpriseUrls
            .filter(url => url !== DOMESTIC_URL && url !== INTERNATIONAL_URL)
            .map(url => {
                const host = (() => { try { return new URL(url).host; } catch { return url; } })();
                return {url, label: `${host}（企业站）`};
            })
    ];
    // 兜底：把模型表里其它未列出的上游追加到最后（标识不明的归到企业站标签）
    for (const url of getCodebuddyBaseUrlOptions()) {
        if (ordered.some(o => o.url === url)) continue;
        const host = (() => { try { return new URL(url).host; } catch { return url; } })();
        const label = enterpriseSet.has(url) ? `${host}（企业站）` : host;
        ordered.push({url, label});
    }

    const optionsHtml = ordered
        .map(({url, label}) => `<option value="${url}">${label}</option>`)
        .join('\n                                ');
    html = html.replaceAll('{{baseUrlOptions}}', optionsHtml);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}


/**
 * 主路由处理函数
 */
export async function routeCodebuddyFrontend(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 主页面 ==========
    if (pathname === '/codebuddyFE' || pathname === '/codebuddyFE/') {
        return serveAdminPage(res);
    }

    // 获取状态
    if (pathname === '/codebuddyFE/status' && method === 'GET') {
        return handleStatus(req, res);
    }

    // 获取最新模型列表（含倍率、能力标签）
    if (pathname === '/codebuddyFE/models' && method === 'GET') {
        return handleModels(req, res);
    }

    // OAuth2 轮询（必须在其他路由之前）
    if (pathname === '/codebuddyFE/auth/poll' && method === 'POST') {
        return handleAuthPoll(req, res);
    }

    // 凭证操作
    if (pathname === '/codebuddyFE/credentials' && method === 'GET') {
        return handleCredentials(req, res, 'list');
    }
    if (pathname === '/codebuddyFE/credentials/delete' && method === 'POST') {
        return handleCredentials(req, res, 'delete');
    }
    if (pathname === '/codebuddyFE/credentials/select' && method === 'POST') {
        return handleCredentials(req, res, 'select');
    }
    if (pathname === '/codebuddyFE/credentials/reorder' && method === 'POST') {
        return handleCredentials(req, res, 'reorder');
    }
    if (pathname === '/codebuddyFE/credentials/priority-clear' && method === 'POST') {
        return handleCredentials(req, res, 'priority-clear');
    }
    if (pathname === '/codebuddyFE/credentials/toggle-disable' && method === 'POST') {
        return handleCredentials(req, res, 'toggle-disable');
    }
    if (pathname === '/codebuddyFE/credentials/reset-ratelimit' && method === 'POST') {
        return handleCredentials(req, res, 'reset-ratelimit');
    }

    // 认证启动
    if (pathname === '/codebuddyFE/auth/start' && method === 'GET') {
        return handleAuthStart(req, res);
    }

    // 刷新统计数据
    if (pathname === '/codebuddyFE/stats/refresh' && method === 'POST') {
        await broadcast('stats-flush');
        credentialStore.flushApiCallCounts();
        const usage = await gatherAllStats('codebuddy');
        return sendJson(res, 200, {message: '数据已刷新', usage});
    }

    // 重置自定义统计数据
    if (pathname === '/codebuddyFE/stats/custom-reset' && method === 'POST') {
        credentialStore.resetCustomStats();
        await broadcast('stats-reset', {service: 'codebuddy'});
        const usage = await gatherAllStats('codebuddy');
        return sendJson(res, 200, {message: '自定义统计数据已重置', usage});
    }

    // 获取每日使用数据
    if (pathname === '/codebuddyFE/stats/daily' && method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const month = urlObj.searchParams.get('month') || '';
        if (!month) {
            return sendJson(res, 400, {error: '缺少 month 参数'});
        }
        const dailyData = credentialStore.getDailyUsage(month);
        return sendJson(res, 200, {month, data: dailyData});
    }

    // 重新生成 API Key
    if (pathname === '/codebuddyFE/regenerate-key' && method === 'POST') {
        return handleRegenerateApiKey(req, res);
    }

    // ========== 积分余额与签到 ==========

    // 查询所有凭证的积分与签到状态
    if (pathname === '/codebuddyFE/billing/status' && method === 'GET') {
        try {
            const status = await queryAllBillingStatus();
            return sendJson(res, 200, {accounts: status, startupCheckin: getStartupCheckinConfig()});
        } catch (err) {
            logger.error('查询积分状态失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 对指定凭证执行签到
    if (pathname === '/codebuddyFE/billing/checkin' && method === 'POST') {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const {userId} = data;

            const tm = credentialStore.getTokenManager();
            const cred = tm.credentials
                .map((c) => c.data)
                .find((c) => (c.user_id || 'unknown') === userId);
            if (!cred) {
                return sendJson(res, 404, {error: '未找到指定凭证'});
            }
            const result = await performCheckin(cred);
            return sendJson(res, 200, result);
        } catch (err) {
            logger.error('签到失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 启动自动签到开关配置
    if (pathname === '/codebuddyFE/billing/startup-checkin' && method === 'POST') {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const enabled = data.enabled === true;
            setStartupCheckinConfig(enabled);
            return sendJson(res, 200, {
                message: enabled ? '已启用启动自动签到' : '已停用启动自动签到',
                startupCheckin: enabled
            });
        } catch (err) {
            logger.error('启动签到开关配置失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 定时任务状态（只读：读本地 _schedule + 查询 Windows 计划任务）
    if (pathname === '/codebuddyFE/schedule/status' && method === 'GET') {
        try {
            const scheduleState = getScheduleState();
            const tasks = {
                checkin: await queryScheduledTask('WorkBuddyApiProxy-Checkin'),
                growth: await queryScheduledTask('WorkBuddyApiProxy-Growth')
            };
            return sendJson(res, 200, {state: scheduleState, tasks});
        } catch (err) {
            logger.error('查询定时任务状态失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // ========== 成长中心（连登 / 猫猫旅行 / 抽奖 / 任务） ==========

    // 查询所有国内个人站账号的成长中心概览（只读）
    if (pathname === '/codebuddyFE/growth/status' && method === 'GET') {
        try {
            const creds = getGrowthCredentials();
            const accounts = [];
            for (const cred of creds) {
                try {
                    accounts.push(await queryGrowthOverview(cred));
                } catch (err) {
                    accounts.push({supported: true, userId: cred.user_id || 'unknown', error: err.message});
                }
            }
            return sendJson(res, 200, {accounts});
        } catch (err) {
            logger.error('查询成长中心状态失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 对指定账号执行成长中心日常（领奖 / 派猫 / 连登管家），幂等
    if (pathname === '/codebuddyFE/growth/run' && method === 'POST') {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const {userId} = data;

            const tm = credentialStore.getTokenManager();
            const cred = tm.credentials
                .map((c) => c.data)
                .find((c) => (c.user_id || 'unknown') === userId);
            if (!cred) {
                return sendJson(res, 404, {error: '未找到指定凭证'});
            }
            const result = await runGrowthDaily(cred);
            return sendJson(res, 200, result);
        } catch (err) {
            logger.error('执行成长中心日常失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 批量执行全部国内账号的成长中心日常
    if (pathname === '/codebuddyFE/growth/run-all' && method === 'POST') {
        try {
            const creds = getGrowthCredentials();
            const results = [];
            for (const cred of creds) {
                try {
                    results.push(await runGrowthDaily(cred));
                } catch (err) {
                    results.push({userId: cred.user_id || 'unknown', error: err.message});
                }
            }
            return sendJson(res, 200, {results});
        } catch (err) {
            logger.error('批量执行成长中心日常失败:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 404
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Not found'}));
}
