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
import {getModelPricing, pickCredentialPerRealm, getModels} from '../services/codebuddy/api.js';
import {probeAccountModels} from '../services/codebuddy/model-probe.js';
import {modelPermissionStore, isUnavailableKind} from '../services/codebuddy/model-permissions.js';
import {mapCodebuddyModelName} from '../services/codebuddy/model-scope.js';
import {
    getGatewayApiKeyInfo,
    regenerateGatewayToken,
    listGatewayApiKeys,
    createGatewayApiKey,
    updateGatewayApiKey,
    deleteGatewayApiKey,
    regenerateApiKey
} from '../services/gateway/auth.js';
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
 *
 * **按账号权限过滤**：面板上展示的是「你这个账号实际能调哪些」，
 * 而不是「上游配置里有哪些」。否则用户照着面板去选，选了才发现 11158。
 * 权限来自 model-permissions 缓存（测试或真实请求失败时积累），
 * 每个模型都带上 `blocked` 标记，面板可以把不可用的灰显而不是直接藏掉——
 * 藏掉会让人以为模型下线了，灰显能说清「是权限不够」。
 */
async function handleModels(req, res) {
    const tm = credentialStore.getTokenManager();

    // 按站点挑代表账号（同一站点有多个号时取第一个，够用了）
    const targets = pickCredentialPerRealm(tm.credentials);

    if (targets.length === 0) {
        return sendJson(res, 200, {models: [], error: 'no_credentials'});
    }

    // 账号文件名 → 该站点的权限视图。权限是按账号记的，
    // 而同站点可能有多个号，所以这里取「该站点所有账号里宽松的那个」：
    // 只要有任意一个号能用，这个模型对用户就是可用的。
    const blockedByRealm = new Map();
    for (const {realm, credential} of targets) {
        const baseUrl = getCodebuddyBaseUrl(credential.base_url);
        const accounts = tm.credentials
            .filter((c) => getCodebuddyBaseUrl(c.data?.base_url) === baseUrl)
            .map((c) => String(c.filePath || '').split(/[\\/]/).pop())
            .filter(Boolean);
        const blocked = new Map();
        for (const acc of accounts) {
            for (const [model, rec] of modelPermissionStore.blockedFor(acc)) {
                // 后面会用「所有账号都没权限才算不可用」的规则收敛，
                // 这里先记录「有多少个号判过它不可用」
                const prev = blocked.get(model);
                if (!prev) {
                    blocked.set(model, {
                        count: 1,
                        reason: rec.reason,
                        kind: rec.kind,
                        total: accounts.length,
                        // 额度类不算「不可用」，但仍然要把提示带出去
                        quotaNote: rec.kind === 'quota' ? rec.reason : ''
                    });
                } else {
                    prev.count++;
                    // 有号是权限问题就优先报权限（比「额度用完」更根本）
                    if (rec.kind === 'forbidden' && prev.kind !== 'forbidden') {
                        prev.kind = rec.kind;
                        prev.reason = rec.reason;
                    }
                }
            }
        }
        // 只有「该站点全部账号都判过不可用」才算真不可用
        for (const [model, info] of Array.from(blocked)) {
            if (info.count < Math.max(1, info.total)) blocked.delete(model);
        }
        blockedByRealm.set(realm, blocked);
    }

    const realms = [];
    // 并发拉取两个站点，任一失败只影响自己那一组
    await Promise.all(
        targets.map(async ({realm, credential}) => {
            try {
                const models = await getModelPricing(credential);
                const blocked = blockedByRealm.get(realm) || new Map();
                const annotated = (Array.isArray(models) ? models : []).map((m) => {
                    // 权限要按「真正发给上游的模型名」判断：gpt-* 会在请求前被
                    // mapCodebuddyModelName 改写成 kimi/deepseek，上游看不到原名，
                    // 也就不会因为它没权限而失败——这类模型对用户是能用的。
                    const upstreamModel = mapCodebuddyModelName(m.id);
                    const rec = blocked.get(upstreamModel);
                    // 只有「权限不足」和「模型不存在」才标成不可用。
                    // 「今日额度用完」不算不可用——那只是当天用超了，明天照常，
                    // 标灰会让人误以为模型坏了或没权限。这类只给一句提示。
                    const unavailable = Boolean(rec) && isUnavailableKind(rec.kind);
                    return {
                        ...m,
                        blocked: unavailable,
                        blockedReason: rec?.reason || '',
                        blockedKind: rec?.kind || null,
                        // 额度提示与「不可用」分开传，前端可以分别展示
                        quotaNote: rec?.kind === 'quota' ? rec.reason : ''
                    };
                });
                realms.push({
                    realm,
                    models: annotated,
                    usableCount: annotated.filter((m) => !m.blocked).length,
                    blockedCount: annotated.filter((m) => m.blocked).length,
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
 * 重新生成默认（第一条）API Key
 * 多 Key 之后仍有「Copilot/Relay 面板共用的那一个」，语义保持不变
 */
function handleRegenerateApiKey(req, res) {
    try {
        const apiKey = regenerateGatewayToken();
        if (apiKey) {
            sendJson(res, 200, {
                message: '默认 API Key 已重新生成，旧 Key 立即失效（仅影响列表第一条）',
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
 * 读取 JSON 请求体（面板侧的 POST 都是一次性小 body）
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Object>}
 */
function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

/**
 * 返回某个账号可测试的模型清单（只读，不消耗积分）
 *
 * 弹窗打开时先调这个让用户勾选，再按勾选结果发起探测。
 * 只打上游 `/v3/config`（模型元数据，不计费），有 60 秒缓存。
 *
 * 两个列表都返回：
 * - `models`：上游看得见的全部模型（有权限的排前面）
 * - `blocked`：已知当前账号调不了的（`11158` 账号类型不支持等），面板据此标灰
 * 勾选列表保留不可用的模型是刻意的：用户可能想验证「是不是真的没权限」，
 * 或者刚升级完套餐想重测。只是默认不给它们打勾。
 *
 * GET /codebuddyFE/credentials/models?index=N
 */
async function handleCredentialModels(req, res, url) {
    const index = Number(url.searchParams.get('index'));
    const manager = credentialStore.getTokenManager();

    if (!Number.isInteger(index) || index < 0 || index >= manager.credentials.length) {
        sendJson(res, 400, {error: '无效的凭证索引'});
        return;
    }

    const entry = manager.credentials[index];
    const credential = entry?.data;
    if (!credential || !credential.bearer_token) {
        sendJson(res, 400, {error: '该凭证没有可用的 token'});
        return;
    }

    try {
        const result = await getModels(credential);
        const account = String(entry.filePath || '').split(/[\\/]/).pop();
        const blockedMap = modelPermissionStore.blockedFor(account);

        const models = (result?.data || [])
            .filter((m) => m && typeof m.id === 'string' && m.id)
            .map((m) => {
                const blocked = blockedMap.get(m.id);
                // 额度用完不标灰：那只是今天用超了，明天照常。
                // 灰色应该只表示「账号没权限」或「模型不存在」。
                const unavailable = Boolean(blocked) && isUnavailableKind(blocked.kind);
                return {
                    id: m.id,
                    name: m.name || m.id,
                    vendor: m.vendor || 'others',
                    blocked: unavailable,
                    blockedReason: blocked?.reason || '',
                    blockedKind: blocked?.kind || null,
                    quotaNote: blocked?.kind === 'quota' ? blocked.reason : ''
                };
            })
            // 有权限的排前面：用户打开弹窗多半先看能用的
            .sort((a, b) => Number(a.blocked) - Number(b.blocked) || a.id.localeCompare(b.id));

        const vendorLabels = {};
        for (const key of VENDOR_ORDER) vendorLabels[key] = VENDOR_META[key].label;

        const blockedList = models
            .filter((m) => m.blocked)
            .map((m) => ({id: m.id, reason: m.blockedReason, kind: m.blockedKind}));

        sendJson(res, 200, {
            models,
            blocked: blockedList,
            blockedCount: blockedList.length,
            usableCount: models.length - blockedList.length,
            vendorLabels,
            vendorOrder: VENDOR_ORDER,
            email: credential.user_info?.email || credential.user_id || 'unknown',
            baseUrl: getCodebuddyBaseUrl(credential.base_url)
        });
    } catch (error) {
        logger.error('获取账号模型列表失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 探测指定账号的模型可用性（SSE 流式返回）
 *
 * 为什么用 SSE 而不是普通 JSON：一批模型串行跑要几十秒，
 * 让面板干等再一次性出结果，用户会以为卡死了。逐条推能让它边测边显示。
 *
 * **models 必须显式传入**：每次探测都是一次真实的上游调用，会按输入 token 计费。
 * 让用户先勾选要测哪几个，成本才在他的控制范围内；默认测全部会在不知情的情况下花钱。
 *
 * 两条纪律都写在 model-probe.js 里：只读探测（不碰冷却/计数）、低并发（避免自己触发 11128）。
 *
 * body: {index: number, models: string[], concurrency?: number}
 */
async function handleTestCredentialModels(req, res) {
    const body = await readJsonBody(req);
    const index = Number(body.index);
    const manager = credentialStore.getTokenManager();

    if (!Number.isInteger(index) || index < 0 || index >= manager.credentials.length) {
        sendJson(res, 400, {error: '无效的凭证索引'});
        return;
    }

    const entry = manager.credentials[index];
    const credential = entry?.data;
    if (!credential || !credential.bearer_token) {
        sendJson(res, 400, {error: '该凭证没有可用的 token'});
        return;
    }

    // 显式要求勾选：不传就报错，而不是"贴心地"测全部
    const models = Array.isArray(body.models) ? body.models.filter((m) => typeof m === 'string' && m) : [];
    if (models.length === 0) {
        sendJson(res, 400, {
            error: '请先勾选要测试的模型',
            hint: '每次探测都是一次真实的上游调用，会按输入 token 消耗积分'
        });
        return;
    }

    // 不传 concurrency 时用默认 2；上限 4，再高容易把 WAF 打出来
    const concurrency = Number.isInteger(body.concurrency)
        ? Math.min(Math.max(1, body.concurrency), 4)
        : undefined;

    // SSE 头一旦写出就不能再改状态码，所以上面所有校验都必须在 writeHead 之前完成
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // 关掉 Nginx 等反代的缓冲，否则逐条推送会被攒成一坨
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, payload) => {
        if (res.writableEnded) return;
        res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent('start', {
        index,
        filename: entry.filePath.split(/[\\/]/).pop(),
        email: credential.user_info?.email || credential.user_id || 'unknown',
        baseUrl: getCodebuddyBaseUrl(credential.base_url),
        total: models.length,
        concurrency: concurrency ?? 2
    });

    try {
        const account = String(entry.filePath || '').split(/[\\/]/).pop();
        const email = credential.user_info?.email || credential.user_id || '';
        const {results, summary, aborted, abortReason} = await probeAccountModels({
            credential,
            models,
            concurrency,
            onResult: (result, done, total) => {
                // 探测结果直接进权限缓存：测出来不可用的模型，以后 /v1/models 就不再返回，
                // 这样客户端（CC Switch 等）拉到的就是「你的账号真能调」的模型。
                try {
                    if (result.status === 'model_unavailable' || result.status === 'quota') {
                        // 用探测已经判好的 kind，不靠 message 反推：
                        // probeOneModel 已经区分了「权限不足 / 模型不存在 / 额度用完」，
                        // 再交给 classifyModelPermission 按文本猜一遍会丢信息。
                        modelPermissionStore.recordVerdict({
                            account,
                            model: result.model,
                            kind: result.kind || (result.status === 'quota' ? 'quota' : 'forbidden'),
                            code: result.code ?? null,
                            reason: result.detail || '',
                            email,
                            baseUrl: credential.base_url || ''
                        });
                    } else if (result.status === 'ok') {
                        // 之前记过不可用但现在通了（升级套餐 / 额度恢复），把记录清掉
                        modelPermissionStore.recordAvailable(account, result.model);
                    }
                } catch (err) {
                    logger.debug(`记录探测权限失败: ${err.message}`);
                }
                // 进度信息照常推给面板
                sendEvent('result', {...result, done, total});
            }
        });
        // 给面板带一份当前权限视图，方便它把不可用的模型标灰
        const blocked = Object.fromEntries(
            Array.from(modelPermissionStore.blockedFor(account).entries()).map(([id, rec]) => [
                id,
                {reason: rec.reason, kind: rec.kind, code: rec.code}
            ])
        );
        sendEvent('done', {
            summary,
            resultCount: results.length,
            aborted: aborted === true,
            abortReason,
            blocked
        });
    } catch (error) {
        logger.error('模型探测失败:', error);
        sendEvent('error', {message: error.message});
    } finally {
        if (!res.writableEnded) res.end();
    }
}

/**
 * 把 Key 记录转成面板用的结构
 *
 * `allowedCount` 只数**仍然存在**的账号：白名单里的文件名对应账号被删掉后，
 * 保存值不能改（改了就是权限放大），但展示上必须让用户看到「勾的号少了」。
 * `allowedMissing` 就是这批失效项，面板据此提示重新勾选。
 *
 * @param {Object} key - listGatewayApiKeys() 的一项
 * @param {string[]} existingFiles - 当前凭证文件名
 */
function toKeyView(key, existingFiles) {
    const scope = key.allowedCredentialFiles ?? null;
    const existing = new Set(existingFiles);
    const missing = scope === null ? [] : scope.filter((f) => !existing.has(f));
    const hit = scope === null ? existingFiles.length : scope.length - missing.length;
    return {
        id: key.id,
        label: key.label,
        prefix: key.prefix,
        plain: key.plain,
        createdAt: key.createdAt,
        allowedCredentialFiles: scope,
        allowedCount: hit,
        allowedMissing: missing,
        unrestricted: scope === null
    };
}

/**
 * 当前凭证文件名列表
 * @returns {string[]}
 */
function currentCredentialFiles() {
    const tm = credentialStore.getTokenManager();
    return (tm.credentials || []).map((c) => String(c.filePath || '').split(/[\\/]/).pop());
}

/**
 * GET /codebuddyFE/api-keys
 */
function handleListApiKeys(req, res) {
    try {
        const files = currentCredentialFiles();
        const keys = listGatewayApiKeys().map((k) => toKeyView(k, files));
        // 失效项让面板能主动提示，但这里不改磁盘上的作用域
        for (const key of keys) {
            if (key.allowedMissing.length > 0) {
                logger.warn(
                    `[Gateway] Key ${key.id} 的作用域含 ${key.allowedMissing.length} 个已失效账号：` +
                        key.allowedMissing.join(', ')
                );
            }
        }
        sendJson(res, 200, {keys, totalCredentials: files.length});
    } catch (error) {
        logger.error('列出 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * POST /codebuddyFE/api-keys — 新建
 */
async function handleCreateApiKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        const created = createGatewayApiKey({label});
        sendJson(res, 200, {key: toKeyView(created, currentCredentialFiles())});
    } catch (error) {
        logger.error('新建 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * POST /codebuddyFE/api-keys/update — 改 label / 账号作用域
 *
 * `allowedCredentialFiles` 三态原样透传：省略 = 不改；null = 不限；数组 = 白名单。
 * 不能把「省略」当成 null，否则改个名字就会把限制放开。
 */
async function handleUpdateApiKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
            sendJson(res, 400, {error: 'id 不能为空'});
            return;
        }

        const patch = {};
        if (typeof body.label === 'string') patch.label = body.label;
        if (Object.prototype.hasOwnProperty.call(body, 'allowedCredentialFiles')) {
            if (body.allowedCredentialFiles !== null && !Array.isArray(body.allowedCredentialFiles)) {
                sendJson(res, 400, {error: 'allowedCredentialFiles 必须是数组或 null'});
                return;
            }
            patch.allowedCredentialFiles = body.allowedCredentialFiles;
        }

        const updated = updateGatewayApiKey(id, patch);
        if (!updated) {
            sendJson(res, 404, {error: 'Key 不存在'});
            return;
        }
        sendJson(res, 200, {key: toKeyView(updated, currentCredentialFiles())});
    } catch (error) {
        logger.error('更新 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * POST /codebuddyFE/api-keys/delete
 */
async function handleDeleteApiKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
            sendJson(res, 400, {error: 'id 不能为空'});
            return;
        }
        const result = deleteGatewayApiKey(id);
        if (!result.ok) {
            sendJson(res, 400, {error: result.error || '删除失败'});
            return;
        }
        sendJson(res, 200, {message: 'Key 已删除'});
    } catch (error) {
        logger.error('删除 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * POST /codebuddyFE/api-keys/regenerate — 重置指定 Key 的明文
 */
async function handleRegenerateApiKeyById(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
            sendJson(res, 400, {error: 'id 不能为空'});
            return;
        }
        const updated = regenerateApiKey(id);
        if (!updated) {
            sendJson(res, 404, {error: 'Key 不存在'});
            return;
        }
        sendJson(res, 200, {key: toKeyView(updated, currentCredentialFiles())});
    } catch (error) {
        logger.error('重置 API Key 失败:', error);
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
    // 面板 HTML 每次都从磁盘重读模板，内容随时可能变；
    // 不给 Cache-Control 的话浏览器会按启发式规则缓存，改完模板刷新看到的还是旧的。
    // no-store 比 no-cache 更彻底：连"带着 ETag 去问一下"都省了，直接要新的。
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
    });
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
    // 模型可用性探测（SSE 逐条返回，见 handleTestCredentialModels）
    if (pathname === '/codebuddyFE/credentials/models' && method === 'GET') {
        return handleCredentialModels(req, res, url);
    }
    if (pathname === '/codebuddyFE/credentials/test-models' && method === 'POST') {
        return handleTestCredentialModels(req, res);
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

    // 重新生成 API Key（默认第一条，兼容旧按钮）
    if (pathname === '/codebuddyFE/regenerate-key' && method === 'POST') {
        return handleRegenerateApiKey(req, res);
    }

    // ========== 多 API Key 管理 ==========
    // 每个 Key 可限定能使用哪些 CodeBuddy 账号；/v1/models 与聊天请求都按此收窄。
    // Copilot / Relay 只校验 Key 有效性，不读 allowedCredentialFiles。
    if (pathname === '/codebuddyFE/api-keys' && method === 'GET') {
        return handleListApiKeys(req, res);
    }
    if (pathname === '/codebuddyFE/api-keys' && method === 'POST') {
        return handleCreateApiKey(req, res);
    }
    if (pathname === '/codebuddyFE/api-keys/update' && method === 'POST') {
        return handleUpdateApiKey(req, res);
    }
    if (pathname === '/codebuddyFE/api-keys/delete' && method === 'POST') {
        return handleDeleteApiKey(req, res);
    }
    if (pathname === '/codebuddyFE/api-keys/regenerate' && method === 'POST') {
        return handleRegenerateApiKeyById(req, res);
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
