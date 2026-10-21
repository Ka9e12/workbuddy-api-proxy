/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * 支持 Responses API WebSocket 端点
 * @module routes/codebuddy
 */

import {
    createChatCompletions,
    getModels,
    CodeBuddyApiError,
    upstreamErrorStatus,
    buildGatewayHint
} from '../services/codebuddy/api.js';
import {anthropicToOpenAI, openAIToAnthropic, ClaudeStreamState, SSEWriter} from '../services/codebuddy/translator.js';
import {
    rewriteOpenAIStream,
    injectBehaviorRules,
    extractConversationKey
} from '../transformer/shared-translator.js';
import {
    responsesRequestToChat,
    chatResponseToResponses,
    createResponsesStreamState,
    chatChunkToResponsesEvents,
    compactRequestToChat,
    chatResponseToCompact
} from '../transformer/responses-translator.js';
import {
    getCredential,
    indexOfCredential,
    noteUpstreamSuccess,
    noteUpstreamFailure,
    noteStreamOutcome
} from '../services/codebuddy/auth.js';
import {classifyStreamOutcome} from '../services/codebuddy/stream-outcome.js';
import {shouldFailover, resolveMaxAttempts, DEFAULT_MAX_ATTEMPTS} from '../services/codebuddy/failover.js';
import {pickScopedModelTargets, mergeModelResults, mapCodebuddyModelName} from '../services/codebuddy/model-scope.js';
import {modelPermissionStore} from '../services/codebuddy/model-permissions.js';
import {credentialStore} from '../services/codebuddy/credential-store.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl} from '../services/codebuddy/config.js';
import {handleWSConnection} from '../services/ws/ws-server.js';
import {intEnv} from '../utils/env.js';
import logger from '../utils/logger.js';

/**
 * 从上游 usage 中提取缓存命中 token 数
 * DeepSeek: prompt_cache_hit_tokens
 * OpenAI: prompt_tokens_details.cached_tokens
 */
function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

// 模型名映射已移到 services/codebuddy/model-scope.js，面板与网关共用同一份规则。
// 这里 import 进来供本模块使用，同时 re-export 保持既有调用方不变。
export {mapCodebuddyModelName};

/**
 * 选择用于统计记录的模型名
 * 优先使用上游返回的模型名，但如果上游返回的是端点 ID（ep- 前缀）等不可读标识，
 * 则回退到客户端请求的模型名
 */
function pickModelName(upstreamModel, clientModel) {
    if (upstreamModel && !upstreamModel.startsWith('ep-')) return upstreamModel;
    return clientModel || upstreamModel;
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送 OpenAI 格式的错误响应
 * @param {number} status
 * @param {string} message
 * @param {string} [type='api_error']
 * @param {string} [hint] - 网关提示，作为并列补充字段（不替换 message）
 */
function sendOpenAIError(res, status, message, type = 'api_error', hint = '') {
    const error = {
        message: message,
        type: type,
        code: status
    };
    if (hint) error.gateway_hint = hint;
    const errorResponse = {error};
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(errorResponse));
}

/**
 * 发送 Anthropic 格式的错误响应
 * @param {number} status
 * @param {string} message
 * @param {string} [hint] - 网关提示，作为并列补充字段（不替换 message）
 */
function sendAnthropicError(res, status, message, hint = '') {
    const error = {
        type: status === 401 ? 'authentication_error' : 'api_error',
        message: message
    };
    if (hint) error.gateway_hint = hint;
    const errorResponse = {type: 'error', error};
    sendJson(res, status, errorResponse);
}

/**
 * 检测并处理上游限速/错误，施加分级冷却
 * 按本次请求实际使用的凭证索引精确归因（替代全局 lastReturnedIndex，避免并发下标记错号）
 * @param {Error} error - 捕获的错误
 * @param {number} [credIndex] - 本次请求使用的凭证索引
 * @param {string} [model] - 本次请求的模型
 */
function handleUpstreamRateLimit(error, credIndex, model) {
    if (error instanceof CodeBuddyApiError) {
        noteUpstreamFailure(error, credIndex, model);
        // 顺手学一下权限：真实请求撞上「账号类型不支持这个模型」时记一笔，
        // 之后 /v1/models 就不再返回它，客户端（CC Switch 等）也就不会选到。
        // 只读记录，不影响账号调度。
        recordModelPermission(credIndex, model, error);
    }
}

/**
 * 把「这个模型对这个账号不可用」记进权限缓存
 * @param {number} credIndex
 * @param {string} model
 * @param {Error} error
 */
function recordModelPermission(credIndex, model, error) {
    if (!Number.isInteger(credIndex) || credIndex < 0 || !model) return;
    const tm = credentialStore.getTokenManager();
    const entry = tm.credentials[credIndex];
    if (!entry?.filePath) return;
    const account = String(entry.filePath).split(/[\\/]/).pop();
    const data = entry.data || {};
    try {
        modelPermissionStore.recordBlocked({
            account,
            model,
            error,
            email: data.user_info?.email || data.user_id || '',
            baseUrl: data.base_url || ''
        });
    } catch (err) {
        // 权限缓存是锦上添花，写失败不能影响请求本身
        logger.debug(`记录模型权限失败: ${err.message}`);
    }
}

/**
 * 真实请求成功时，清掉该模型的「不可用」记录
 *
 * 为什么需要：权限不是永久的。用户升级套餐、或者上次只是额度用完，
 * 之后一次成功调用就证明它能用了，缓存必须跟着改回来——
 * 否则用户会看到「明明刚用成功过，列表里还标着不可用」。
 * @param {number} credIndex
 * @param {string} model
 */
function clearModelPermission(credIndex, model) {
    if (!Number.isInteger(credIndex) || credIndex < 0 || !model) return;
    const tm = credentialStore.getTokenManager();
    const entry = tm.credentials[credIndex];
    if (!entry?.filePath) return;
    const account = String(entry.filePath).split(/[\\/]/).pop();
    try {
        modelPermissionStore.recordAvailable(account, model);
    } catch (err) {
        logger.debug(`清除模型权限记录失败: ${err.message}`);
    }
}

/**
 * 流终态归因：把 classifyStreamOutcome 的结果落到账号状态上
 * - 上游 error 帧若带 status/code：构造 CodeBuddyApiError 交给既有分级逻辑（402/404/429/5xx 全部复用）
 * - 其余终态（成功/网络/空流/客户端断开）：走 noteStreamOutcome
 * @param {Object} opts
 * @param {number} opts.credIndex
 * @param {string} [opts.model]
 * @param {string} [opts.sessionKey]
 * @param {Error|null} [opts.error] - 流错误（若有）
 * @param {boolean} [opts.aborted]
 * @param {boolean} [opts.sawUpstreamErrorFrame]
 * @param {boolean} [opts.receivedAnyDelta]
 * @param {Object|null} [opts.errorFrame] - 解析出的上游 error 对象（可能带 status/code）
 */
function accountStreamOutcome({credIndex, model, sessionKey, affinityScope, error = null, aborted = false, sawUpstreamErrorFrame = false, receivedAnyDelta = false, errorFrame = null}) {
    if (!Number.isInteger(credIndex) || credIndex < 0) return;

    // 流被中断（网络错误/客户端断开）优先按中断归因——此时即使之前出现过 error 帧，
    // 也不是"上游业务失败"，不该罚账号
    if (error) {
        const outcome = classifyStreamOutcome({error, aborted, receivedAnyDelta});
        noteStreamOutcome(credIndex, outcome, {sessionKey, affinityScope, errorFrame});
        return;
    }

    // 上游业务错误帧带状态码：复用既有分级（避免 429 被误当 5xx）
    if (errorFrame && (errorFrame.status || errorFrame.code)) {
        handleUpstreamRateLimit(
            new CodeBuddyApiError(errorFrame.status ?? 502, errorFrame.message || 'Upstream error frame', {
                code: errorFrame.code ?? null
            }),
            credIndex,
            model
        );
        return;
    }

    const outcome = classifyStreamOutcome({aborted, sawUpstreamErrorFrame, receivedAnyDelta});
    // 带上 errorFrame：即便本分支按 5xx 语义记熔断，noteStreamOutcome 也会
    // 先识别渠道级错误码（6021/11128）并短路，不误罚账号
    noteStreamOutcome(credIndex, outcome, {sessionKey, affinityScope, errorFrame});

    // 流正常跑完就是「这个模型能用」的实证：清掉之前记的不可用
    // （升级套餐后、或上次只是额度用完，都会走到这里）
    if (outcome === 'success' && model) {
        clearModelPermission(credIndex, model);
    }
}

/**
 * 非流式请求成功后：清账号失败计数，并清掉该模型的「不可用」记录
 * @param {number} credIndex
 * @param {string} [model] - 成功用到的模型；传了就顺手更新权限缓存
 */
function noteNonStreamSuccess(credIndex, model) {
    noteUpstreamSuccess(credIndex);
    if (model) clearModelPermission(credIndex, model);
}

/**
 * 取本次请求所用 API Key 的 CodeBuddy 账号作用域
 *
 * 网关鉴权时挂在 `req._gatewayKey` 上；`allowedCredentialFiles` 三态：
 * null = 不限（老 Key 与默认 Key 都是这个值），数组 = 白名单。
 * copilot / relay 不读这个字段。
 * @param {Object} req
 * @returns {null|string[]}
 */
function scopeOf(req) {
    return req?._gatewayKey?.allowedCredentialFiles ?? null;
}

/**
 * 作用域命名空间：让同一会话在不同 Key 下各绑各的账号，互不解绑。
 * 不限账号的 Key 统一用 '*'，多个老 Key 之间共享粘性是正确行为（它们看到的是同一个池）。
 * @param {Object} req
 * @returns {string}
 */
function affinityScopeOf(req) {
    const key = req?._gatewayKey;
    if (!key) return '*';
    const scope = key.allowedCredentialFiles;
    if (scope === null || scope === undefined) return '*';
    return `${key.id}:${scope.length}`;
}

/**
 * 获取凭证，若无可用凭证则返回错误
 * 网关层已统一完成客户端 API Key 鉴权
 * @param {Object} [opts]
 * @param {Object} [opts.req] - 原始请求（用于读取 Key 作用域）
 * @param {string} [opts.sessionKey] - 会话键（用于粘性绑定）
 * @param {string} [opts.model] - 当前请求模型（用于模型级冷却判定）
 * @param {number[]} [opts.excludeIndexes] - 本次请求已失败过的账号
 * @param {boolean} [opts.preferDifferentSite] - 优先挑不同上游站点
 */
function getCredentialOrFail(opts = {}) {
    const {req, ...rest} = opts;
    const credential = getCredential({
        ...rest,
        allowedFilenames: scopeOf(req),
        affinityScope: affinityScopeOf(req)
    });
    if (!credential) {
        return {error: {status: 503, message: 'No available credentials'}};
    }
    return {credential};
}

/**
 * 作用域内还能用的账号数量（供 failover 判断值不值得重试）
 * @param {Object} req
 * @param {string} [model]
 * @returns {number}
 */
function countUsableCredentials(req, model) {
    const tm = credentialStore.getTokenManager();
    const allowed = scopeOf(req);
    const allowedSet = allowed === null || allowed === undefined ? null : new Set(allowed.map(String));
    let count = 0;
    for (let i = 0; i < tm.credentials.length; i++) {
        const entry = tm.credentials[i];
        const filename = String(entry.filePath || '').split(/[\\/]/).pop();
        if (allowedSet !== null && !allowedSet.has(filename)) continue;
        if (tm.disabledIndexes.includes(i)) continue;
        if (tm.isRateLimited(i)) continue;
        if (model && tm.isModelCooled(i, model)) continue;
        if (tm.isTokenExpired(entry.data)) continue;
        count++;
    }
    return count;
}

/**
 * 在同一请求内获取上游响应，失败时换号重试
 *
 * 为什么放在这里做：换号只发生在客户端下一次请求上，而客户端每次重试都要重新
 * 等一遍上游超时（首字节 120s），用户看到的就是"卡几分钟无提示"。给一次同请求内的
 * 换号机会，能把这段等待压缩成「一次超时 + 一次成功」。
 *
 * 安全边界：本函数只能在 `writeHead(200)` 之前调用。一旦开流就不能换号，
 * 否则会把两条上游的流拼成一条发给客户端。
 *
 * @param {Object} params
 * @param {Object} params.req - 原始请求（读 Key 作用域）
 * @param {string} [params.sessionKey]
 * @param {string} [params.model]
 * @param {Function} params.send - (payload, credential, meta) => Promise<response>
 *        payload 已在外部构造好，credential 由本函数挑选
 * @param {Function} [params.onFailure] - (error, credIndex, model) => void，用于归因冷却
 * @returns {Promise<{response: Object, credential: Object, credIndex: number, meta: Object}>}
 */
async function requestWithFailover({req, sessionKey, model, send, onFailure}) {
    const maxAttempts = resolveMaxAttempts(
        countUsableCredentials(req, model),
        intEnv('CODEBUDDY_FAILOVER_ATTEMPTS', {default: DEFAULT_MAX_ATTEMPTS, min: 1, max: 5})
    );

    const triedIndexes = [];
    let lastError = null;
    let lastCredential = null;
    let lastCredIndex = -1;
    let lastMeta = {};

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const authResult = getCredentialOrFail({
            req,
            sessionKey,
            model,
            // 第一次不排除任何号；重试时排除已试过的，并优先换站点
            excludeIndexes: triedIndexes.length > 0 ? triedIndexes : undefined,
            preferDifferentSite: triedIndexes.length > 0
        });

        if (authResult.error) {
            // 没有可用号了：如果之前失败过，把上游错误回给客户端（更能说明问题）；
            // 否则报"无可用凭证"
            if (lastError) break;
            throw Object.assign(new Error(authResult.error.message), {status: authResult.error.status});
        }

        const credential = authResult.credential;
        const credIndex = indexOfCredential(credential);
        const meta = {attempt, isRetry: attempt > 0};

        try {
            const response = await send(credential, meta);
            return {response, credential, credIndex, meta};
        } catch (error) {
            lastError = error;
            lastCredential = credential;
            lastCredIndex = credIndex;
            lastMeta = meta;

            // 先归因：让冷却/熔断照常生效，下一次选号就不会再挑它
            if (onFailure) onFailure(error, credIndex, model);

            if (credIndex >= 0) triedIndexes.push(credIndex);

            const moreAttemptsLeft = attempt + 1 < maxAttempts;
            if (!moreAttemptsLeft || !shouldFailover(error)) {
                throw error;
            }

            logger.warn(
                `[CodeBuddy] 请求失败，换号重试（第 ${attempt + 2}/${maxAttempts} 次）：` +
                    `${error.message?.slice(0, 120) || error}`
            );
        }
    }

    // 重试中把号用光了：抛最后一次的错误
    if (lastError) throw lastError;
    throw Object.assign(new Error('No available credentials'), {status: 503, credential: lastCredential, meta: lastMeta});
}

/**
 * 解析请求体
 */
async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * 处理 OpenAI 格式的 /v1/chat/completions 请求 - 直接透传
 */
async function handleOpenAIChatCompletions(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        // 解析 OpenAI 格式的请求
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);
        openAIPayload.model = mapCodebuddyModelName(openAIPayload.model);
        model = openAIPayload.model;

        // 会话粘性：从原始请求提取会话键，优先复用同一凭证
        sessionKey = extractConversationKey(req, openAIPayload);

        // 注入行为规则（统一在路由层注入一次，重试复用同一份 payload）
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);

        // 选号 + 单次上游调用；失败时在同一请求内换号重试
        // （此时还没 writeHead，客户端一个字节都没收到，换号对它完全透明）
        const outcome = await requestWithFailover({
            req,
            sessionKey,
            model,
            onFailure: (error, idx, m) => handleUpstreamRateLimit(error, idx, m),
            send: (credential) =>
                createChatCompletions(openAIPayload, {
                    credential,
                    conversationId: req.headers['x-conversation-id'],
                    sessionKey,
                    conversationRequestId: req.headers['x-conversation-request-id'],
                    conversationMessageId: req.headers['x-conversation-message-id'],
                    requestId: req.headers['x-request-id']
                })
        });
        const response = outcome.response;
        credIndex = outcome.credIndex;

        // 流式响应：使用 rewriteOpenAIStream 对 reasoning_content 做缓冲合并，避免 thinking 被逐 token 刷成多个块
        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            rewriteOpenAIStream(
                res,
                response.body,
                (inputTokens, outputTokens, cacheHitTokens, credit, model) => {
                    credentialStore.incrementApiCallCount();
                    credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    credentialStore.incrementCreditUsage(credit);
                    credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);
                },
                {
                    // 成功判定延后到流真正结束（而非拿到 200 响应头就记成功）
                    onStreamEnd: (facts) => accountStreamOutcome({credIndex, model, sessionKey, affinityScope: affinityScopeOf(req), ...facts}),
                    onStreamError: (err, facts) =>
                        accountStreamOutcome({credIndex, model, sessionKey, affinityScope: affinityScopeOf(req), error: err, aborted: res.destroyed, ...facts})
                }
            );
        } else {
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);
            // 非流式：聚合成功返回后才记成功
            noteNonStreamSuccess(credIndex, model);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

            const openAIResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || openAIPayload.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: aggregated.content || null,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop'
                    }
                ],
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            sendJson(res, 200, openAIResponse);
        }
    } catch (error) {
        logger.error('Failed to handle OpenAI chat completions:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error', 'api_error', buildGatewayHint(error, model));
    }
}

/**
 * 拉取并合并作用域内各站点的模型列表
 *
 * 分组与合并的规则在 `services/codebuddy/model-scope.js` 里，便于单测直接盯住
 * 「按 baseUrl 而不是 realm 分组」这条约束。
 *
 * **按权限过滤**：上游 `/v3/config` 给的是「客户端能看见的模型」，不是「你的账号能调的」。
 * 免费账号能看见 gpt-5.5 但一调就 11158，客户端（CC Switch 等）选了才报错。
 * 所以这里按「模型来源账号」查一遍已知权限，不可用的直接不返回。
 *
 * @param {null|string[]} allowedFilenames
 * @returns {Promise<{targets: Array, models: Array, filtered: Array}>}
 */
async function collectScopedModels(allowedFilenames) {
    const tm = credentialStore.getTokenManager();
    const targets = pickScopedModelTargets(tm, allowedFilenames);
    if (targets.length === 0) return {targets, models: [], filtered: []};

    const settled = await Promise.allSettled(
        targets.map(async ({baseUrl, account, credential}) => {
            const result = await getModels(credential);
            return {
                account,
                models: Array.isArray(result?.data) ? result.data : []
            };
        })
    );
    for (const outcome of settled) {
        if (outcome.status === 'rejected') {
            logger.warn('拉取站点模型列表失败:', outcome.reason?.message || outcome.reason);
        }
    }

    // 先合并去重，再按「该模型的来源账号」逐条查权限。
    // 同一个模型可能来自多个账号，只要有一个账号能用就保留。
    const merged = mergeModelResults(settled);
    const sourceAccounts = new Map();
    for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue;
        const account = outcome.value.account;
        if (!account) continue;
        for (const m of outcome.value.models) {
            if (!m?.id) continue;
            if (!sourceAccounts.has(m.id)) sourceAccounts.set(m.id, []);
            sourceAccounts.get(m.id).push(account);
        }
    }

    const models = [];
    const filtered = [];
    for (const model of merged) {
        // 权限要按「真正发给上游的模型名」判断。
        // `gpt-5.5` 这类名字会在请求前被 mapCodebuddyModelName 改写成 kimi-k2.6，
        // 上游永远看不到 gpt-5.5，也就不会因为它没权限而失败——
        // 对客户端来说这个模型是可用的，不能过滤掉。
        const upstreamModel = mapCodebuddyModelName(model.id);
        const accounts = sourceAccounts.get(model.id) || [];

        // 没有任何来源账号信息时不做过滤（保守：宁可多给，也别把能用的藏起来）
        if (accounts.length === 0) {
            models.push(model);
            continue;
        }
        // 只要有一个来源账号能用就保留。
        // 注意：额度类（6004「今日用完」）不算不可用——明天就恢复，
        // 从列表里拿掉会让客户端以为这个模型不存在。
        const hasUsableAccount = accounts.some((acc) => {
            const verdict = modelPermissionStore.isBlocked(acc, upstreamModel);
            return !verdict.blocked || verdict.kind === 'quota';
        });
        if (hasUsableAccount) {
            models.push(model);
        } else {
            filtered.push({
                id: model.id,
                reason:
                    modelPermissionStore.isBlocked(accounts[0], upstreamModel).reason || '当前账号不可用'
            });
        }
    }

    return {targets, models, filtered};
}

/**
 * 处理 OpenAI 格式的 /v1/models 请求
 *
 * 按调用方 API Key 的作用域收窄：只返回被允许账号所属站点的模型。
 */
async function handleOpenAIModels(req, res) {
    try {
        const {targets, models, filtered} = await collectScopedModels(scopeOf(req));
        if (targets.length === 0) {
            sendOpenAIError(res, 503, 'No available credentials for this API key', 'api_error');
            return;
        }
        if (models.length === 0) {
            sendOpenAIError(res, 503, 'No available models for this API key', 'api_error');
            return;
        }
        if (filtered.length > 0) {
            logger.debug(
                `[CodeBuddy] /v1/models 按账号权限过滤掉 ${filtered.length} 个模型: ` +
                    filtered.map((f) => `${f.id}(${f.reason})`).join(', ')
            );
        }

        // 返回 OpenAI 格式
        sendJson(res, 200, {
            object: 'list',
            data: models.map((model) => ({
                id: model.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: model.vendor || 'codebuddy'
            }))
        });
    } catch (error) {
        logger.error('Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        // 解析 Anthropic 格式的请求
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        // 转换为 OpenAI 格式（注意：会话键必须从原始 anthropicPayload 提取，
        // 转换后会丢弃 metadata 且首条 user 内容被改写）
        const openAIPayload = anthropicToOpenAI(anthropicPayload);
        openAIPayload.model = mapCodebuddyModelName(openAIPayload.model);
        model = openAIPayload.model;

        // 会话粘性：从原始请求提取会话键
        sessionKey = extractConversationKey(req, anthropicPayload);

        // 注入行为规则（translateMessages 不再内部注入，统一在路由层注入一次）
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);

        // 选号 + 上游调用；失败时同请求内换号重试（此时尚未 writeHead）
        const outcome = await requestWithFailover({
            req,
            sessionKey,
            model,
            onFailure: (error, idx, m) => handleUpstreamRateLimit(error, idx, m),
            send: (credential) =>
                createChatCompletions(openAIPayload, {
                    credential,
                    conversationId: req.headers['x-conversation-id'],
                    sessionKey,
                    conversationRequestId: req.headers['x-conversation-request-id'],
                    conversationMessageId: req.headers['x-conversation-message-id'],
                    requestId: req.headers['x-request-id']
                })
        });
        const response = outcome.response;
        credIndex = outcome.credIndex;

        // 判断是否为流式响应
        if (anthropicPayload.stream) {
            // 流式响应
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const writer = new SSEWriter(res);
            const state = new ClaudeStreamState(writer);

            let buffer = Buffer.alloc(0);
            let partialTextBuffer = '';
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let streamCredit = 0;
            let streamModel = '';
            let sawUpstreamErrorFrame = false;
            let receivedAnyDelta = false;
            let upstreamErrorFrame = null;

            const responseBody = response.body;

            responseBody.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);

                let start = 0;
                let newLineIndex;

                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;

                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;

                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;

                    let data;
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }

                    // 上游业务错误帧（限流/审核等可能伪装成正常结束）
                    if (data.error) {
                        sawUpstreamErrorFrame = true;
                        upstreamErrorFrame = data.error;
                    }

                    const choice = data.choices?.[0];
                    const delta = choice?.delta;
                    if (choice || delta) receivedAnyDelta = true;

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
                    }
                    if (data.model) streamModel = data.model;

                    state.startMessage(data.model);

                    // 提取推理文本：delta.thinking 可能是字符串或对象 { content, signature }
                    let reasoningText = null;
                    let signature = null;

                    if (delta?.reasoning_content) {
                        reasoningText = delta.reasoning_content;
                    } else if (typeof delta?.thinking === 'string') {
                        reasoningText = delta.thinking;
                    } else if (typeof delta?.thinking === 'object' && delta.thinking !== null) {
                        reasoningText = delta.thinking.content || null;
                        signature = delta.thinking.signature || null;
                    } else if (delta?.thought) {
                        reasoningText = typeof delta.thought === 'string' ? delta.thought : null;
                    } else if (delta?.reasoning) {
                        reasoningText = typeof delta.reasoning === 'string' ? delta.reasoning : null;
                    }

                    if (!signature) {
                        signature =
                            delta?.reasoning_signature ||
                            (choice?.finish_reason === 'thinking' ? Date.now().toString() : null);
                    }

                    if (reasoningText) {
                        state.appendThinking(reasoningText);
                    }
                    if (signature) {
                        state.closeThinking(signature);
                    }

                    if (Array.isArray(delta?.tool_calls)) {
                        for (const tool of delta.tool_calls) {
                            const idx = tool.index;
                            if (tool.function?.name) {
                                // 传入 kimi 返回的原始 tool.id，保证 tool_use_id 与上游 tool_call_id 一致
                                // 否则 Claude Code 下一轮 tool_result 携带的 id 将无法被 kimi 识别，导致 invoke model error
                                state.startTool(idx, tool.function.name, tool.id);
                            }
                            if (tool.function?.arguments) {
                                state.appendToolArgs(idx, tool.function.arguments);
                            }
                        }
                    }

                    // 判断是否有推理内容（使用已提取的 reasoningText 避免重复逻辑）
                    if (delta?.content && !reasoningText) {
                        partialTextBuffer += delta.content;
                    }

                    if (choice?.finish_reason) {
                        if (partialTextBuffer) {
                            state.appendText(partialTextBuffer);
                            partialTextBuffer = '';
                        }

                        if (choice.finish_reason === 'tool_calls') {
                            state.finalStopReason = 'tool_use';
                        } else if (choice.finish_reason === 'length') {
                            state.finalStopReason = 'max_tokens';
                        } else {
                            state.finalStopReason = 'end_turn';
                        }
                    }
                }

                if (start > 0) {
                    buffer = buffer.subarray(start);
                }
            });

            responseBody.on('end', () => {
                if (partialTextBuffer) {
                    state.appendText(partialTextBuffer);
                    partialTextBuffer = '';
                }
                state.endMessage(state.finalStopReason, {
                    inputTokens: streamInputTokens,
                    outputTokens: streamOutputTokens,
                    cacheHitTokens: streamCacheHitTokens
                });
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                credentialStore.incrementCreditUsage(streamCredit);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit);
                res.end();
                // 成功判定延后到流真正结束；若中途出现过 error 帧，按上游失败归因
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    affinityScope: affinityScopeOf(req),
                    sawUpstreamErrorFrame,
                    receivedAnyDelta,
                    errorFrame: upstreamErrorFrame
                });
            });

            responseBody.on('error', (err) => {
                logger.error('Stream error:', err);
                state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));
                state.finalStopReason = 'error';
                state.endMessage('error');
                res.end();
                // 修复此前"流中途失败不入账"的缺口
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    affinityScope: affinityScopeOf(req),
                    error: err,
                    aborted: res.destroyed,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta
                });
            });
        } else {
            // 非流式响应
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);
            noteNonStreamSuccess(credIndex, model);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

            const openAIResponse = {
                id: aggregated.id || `msg_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || openAIPayload.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: aggregated.content || null,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop',
                        logprobs: null
                    }
                ],
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            const anthropicResponse = openAIToAnthropic(openAIResponse);

            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Failed to handle Anthropic messages:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error', buildGatewayHint(error, model));
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        // 本地估算，不调用上游：无需检查凭证
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4);

        sendJson(res, 200, {input_tokens: estimatedTokens});
    } catch (error) {
        logger.error('Failed to count tokens:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const {targets, models, filtered} = await collectScopedModels(scopeOf(req));
        if (targets.length === 0) {
            sendAnthropicError(res, 503, 'No available credentials for this API key');
            return;
        }
        if (models.length === 0) {
            sendAnthropicError(res, 503, 'No available models for this API key');
            return;
        }
        if (filtered.length > 0) {
            logger.debug(
                `[CodeBuddy] /anthropic/v1/models 按账号权限过滤掉 ${filtered.length} 个模型: ` +
                    filtered.map((f) => `${f.id}(${f.reason})`).join(', ')
            );
        }

        sendJson(res, 200, {
            data: models.map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'codebuddy',
                name: model.name,
                capabilities: {}
            })),
            object: 'list'
        });
    } catch (error) {
        logger.error('Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI Responses API 请求 (/codebuddy/v1/responses)
 * 将 Responses 格式转为 Chat Completions 发给上游，再将响应转回 Responses 格式
 */
async function handleResponsesAPI(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        // Responses -> Chat Completions
        const chatReq = responsesRequestToChat(responsesReq);
        chatReq.model = mapCodebuddyModelName(chatReq.model);
        model = chatReq.model;

        // 会话粘性：从原始 responsesReq（含 input）提取
        sessionKey = extractConversationKey(req, responsesReq);

        chatReq.messages = injectBehaviorRules(chatReq.messages);

        // 选号 + 上游调用；失败时同请求内换号重试（此时尚未 writeHead）
        const outcome = await requestWithFailover({
            req,
            sessionKey,
            model,
            onFailure: (error, idx, m) => handleUpstreamRateLimit(error, idx, m),
            send: (credential) =>
                createChatCompletions(chatReq, {
                    credential,
                    conversationId: req.headers['x-conversation-id'],
                    sessionKey,
                    conversationRequestId: req.headers['x-conversation-request-id'],
                    conversationMessageId: req.headers['x-conversation-message-id'],
                    requestId: req.headers['x-request-id']
                })
        });
        const response = outcome.response;
        credIndex = outcome.credIndex;

        if (responsesReq.stream) {
            // 流式：解析 Chat SSE -> Responses SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let streamCredit = 0;
            let streamModel = '';
            let sawUpstreamErrorFrame = false;
            let receivedAnyDelta = false;
            let upstreamErrorFrame = null;

            response.body.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;

                    let data;
                    try { data = JSON.parse(raw); } catch { continue; }

                    // 上游业务错误帧（可能伪装成正常结束）
                    if (data.error) {
                        sawUpstreamErrorFrame = true;
                        upstreamErrorFrame = data.error;
                    }
                    if (data.choices?.[0] || data.usage) receivedAnyDelta = true;

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
                    }
                    if (data.model) streamModel = data.model;

                    const events = chatChunkToResponsesEvents(data, streamState);
                    for (const ev of events) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                // 如果没有正常完成，兜底发送 response.completed
                if (!streamState.started || !streamState.finished) {
                    if (streamState.reasoningOpen) {
                        res.write(`event: response.reasoning_summary_part.done\ndata: ${JSON.stringify({type: 'response.reasoning_summary_part.done', output_index: streamState.outputIndex, summary_index: 0, item_id: streamState.reasoningItemId, part: {type: 'summary_text', text: streamState.reasoningText}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'reasoning', id: streamState.reasoningItemId, status: 'completed', summary: [{type: 'summary_text', text: streamState.reasoningText}]}})}\n\n`);
                        streamState.outputIndex++;
                    }
                    if (streamState.messageOpen) {
                        res.write(`event: response.content_part.done\ndata: ${JSON.stringify({type: 'response.content_part.done', output_index: streamState.outputIndex, content_index: 0, part: {type: 'output_text', text: streamState.textBuffer, annotations: []}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'message', id: streamState.currentMessageId, status: 'completed', role: 'assistant', content: [{type: 'output_text', text: streamState.textBuffer, annotations: []}]}})}\n\n`);
                    }
                    res.write(`event: response.completed\ndata: ${JSON.stringify({type: 'response.completed', response: {id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: streamModel || 'unknown', output: [], usage: {input_tokens: streamInputTokens, output_tokens: streamOutputTokens, total_tokens: streamInputTokens + streamOutputTokens}}})}\n\n`);
                }
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                credentialStore.incrementCreditUsage(streamCredit);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit);
                res.end();
                // 成功判定延后到流真正结束；若中途出现过 error 帧，按上游失败归因
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    affinityScope: affinityScopeOf(req),
                    sawUpstreamErrorFrame,
                    receivedAnyDelta,
                    errorFrame: upstreamErrorFrame
                });
            });

            response.body.on('error', (err) => {
                logger.error('Responses stream error:', err);
                res.end();
                // 修复此前"流中途失败不入账"的缺口
                accountStreamOutcome({
                    credIndex,
                    model,
                    sessionKey,
                    affinityScope: affinityScopeOf(req),
                    error: err,
                    aborted: res.destroyed,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta
                });
            });
        } else {
            // 非流式
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);
            noteNonStreamSuccess(credIndex, model);

            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage?.credit || 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

            const chatResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || chatReq.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: aggregated.content || null,
                        reasoning_content: aggregated.reasoningContent || undefined,
                        tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                    },
                    finish_reason: aggregated.finishReason || 'stop'
                }],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        logger.error('Failed to handle Responses API:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error', 'api_error', buildGatewayHint(error, model));
    }
}

/**
 * 处理 OpenAI Responses Compact 请求 (/codebuddy/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    let credIndex = -1;
    let model = null;
    let sessionKey = null;
    try {
        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        // Compact -> Chat Completions
        const chatReq = compactRequestToChat(compactReq);
        chatReq.model = mapCodebuddyModelName(chatReq.model);
        model = chatReq.model;

        // 会话粘性：从原始 compactReq 提取
        sessionKey = extractConversationKey(req, compactReq);

        chatReq.messages = injectBehaviorRules(chatReq.messages);

        // 选号 + 上游调用；失败时同请求内换号重试
        const outcome = await requestWithFailover({
            req,
            sessionKey,
            model,
            onFailure: (error, idx, m) => handleUpstreamRateLimit(error, idx, m),
            send: (credential) =>
                createChatCompletions(chatReq, {
                    credential,
                    conversationId: req.headers['x-conversation-id'],
                    sessionKey
                })
        });
        const response = outcome.response;
        credIndex = outcome.credIndex;

        const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
        const aggregated = await aggregateStreamResponse(response.body);
        // 非流式：聚合成功返回后才记成功
        noteNonStreamSuccess(credIndex, model);

        const inputTokens = aggregated.usage?.prompt_tokens || 0;
        const outputTokens = aggregated.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
        const credit = aggregated.usage?.credit || 0;
        credentialStore.incrementApiCallCount();
        credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
        credentialStore.incrementCreditUsage(credit);
        credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

        const chatResponse = {
            id: aggregated.id || `chatcmpl_${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: aggregated.model || chatReq.model,
            choices: [{
                index: 0,
                message: {role: 'assistant', content: aggregated.content || null},
                finish_reason: aggregated.finishReason || 'stop'
            }],
            usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
        };

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Failed to handle Responses Compact:', error);
        handleUpstreamRateLimit(error, credIndex, model);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error', 'api_error', buildGatewayHint(error, model));
    }
}

/**
 * 处理凭证管理端点
 */
async function handleCredentials(req, res, method, pathname) {
    const tm = credentialStore.getTokenManager();

    try {
        // GET /v1/credentials - 列出所有凭证
        if (method === 'GET' && pathname === '/v1/credentials') {
            const credentials = tm.getCredentialsInfo();
            sendJson(res, 200, {credentials});
            return;
        }

        // GET /v1/credentials/current - 获取当前凭证
        if (method === 'GET' && pathname === '/v1/credentials/current') {
            const info = tm.getCurrentCredentialInfo();
            sendJson(res, 200, info);
            return;
        }

        // POST /v1/credentials - 添加新凭证
        if (method === 'POST' && pathname === '/v1/credentials') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (!data.bearer_token) {
                sendOpenAIError(res, 400, 'bearer_token is required');
                return;
            }

            // 阻止使用已废弃域名
            try {
                const credentialHost = new URL(getCodebuddyBaseUrl(data.base_url)).host;
                if (BLOCKED_DOMAINS.includes(credentialHost)) {
                    sendOpenAIError(res, 400, `域名 ${credentialHost} 已废弃，不允许添加凭证`);
                    return;
                }
            } catch {
                // base_url 格式无效，由下游处理
            }

            const success = tm.addCredentialWithData(data, data.filename);
            if (success) {
                sendJson(res, 200, {message: 'Credential added successfully'});
            } else {
                sendOpenAIError(res, 500, 'Failed to save credential');
            }
            return;
        }

        // POST /v1/credentials/select - 手动选择凭证
        if (method === 'POST' && pathname === '/v1/credentials/select') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const success = tm.setManualCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} selected successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid credential index');
            }
            return;
        }

        // POST /v1/credentials/auto - 恢复自动轮换
        if (method === 'POST' && pathname === '/v1/credentials/auto') {
            tm.clearManualSelection();
            sendJson(res, 200, {message: 'Resumed automatic credential rotation'});
            return;
        }

        // POST /v1/credentials/toggle-rotation - 切换自动轮换
        if (method === 'POST' && pathname === '/v1/credentials/toggle-rotation') {
            const isEnabled = tm.toggleAutoRotation();
            sendJson(res, 200, {
                message: `Auto rotation ${isEnabled ? 'enabled' : 'disabled'}`,
                auto_rotation_enabled: isEnabled
            });
            return;
        }

        // POST /v1/credentials/delete - 删除凭证
        if (method === 'POST' && pathname === '/v1/credentials/delete') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const success = tm.deleteCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} deleted successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid index or failed to delete credential');
            }
            return;
        }

        sendOpenAIError(res, 404, 'Credential endpoint not found');
    } catch (error) {
        logger.error('Credential management error:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理根路径 - 服务信息
 */
function handleRoot(req, res) {
    const tm = credentialStore.getTokenManager();
    const info = tm.getCurrentCredentialInfo();
    sendJson(res, 200, {
        name: 'WorkBuddy API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic'],
        authenticated: tm.hasCredentials(),
        currentCredential: info,
        endpoints: {
            openai: {
                chatCompletions: 'POST /codebuddy/v1/chat/completions - OpenAI format',
                responses: 'POST /codebuddy/v1/responses - Responses API',
                responsesCompact: 'POST /codebuddy/v1/responses/compact - Responses Compact API',
                models: 'GET /codebuddy/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /codebuddy/anthropic/v1/messages - Claude format',
                countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                models: 'GET /codebuddy/anthropic/v1/models - Claude format models'
            },
            credentials: 'GET/POST /codebuddy/v1/credentials - Manage credentials'
        },
        configuration: {
            autoRotation: tm.autoRotationEnabled,
            rotationCount: tm.rotationCount,
            credsDir: '.codebuddy'
        }
    });
}

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 CodeBuddy Responses API WebSocket 连接
 * 客户端通过 WS 连接 /codebuddy/v1/responses，发送标准 Responses API WS 协议
 * CodeBuddy 上游使用 OpenAI Chat HTTP，服务端做 WS→HTTP→WS 转换
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
export function handleCodebuddyResponsesWS(clientWs, req) {
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            // Responses → Chat Completions 转换（先转换以获得模型名，用于按模型冷却判定）
            const mappedModel = mapCodebuddyModelName(payload.model);
            const chatReq = responsesRequestToChat({...payload, model: mappedModel});

            // 会话粘性：从原始 WS payload 提取会话键
            const sessionKey = extractConversationKey(req, payload);
            // WS 完全绕过 routeCodebuddyRequest，作用域必须在这里手动传：
            // 只改 HTTP 那四个调用点会让受限 Key 通过 WS 通道越权。
            chatReq.messages = injectBehaviorRules(chatReq.messages);
            chatReq.stream = true;

            // 选号 + 上游调用；失败时同请求内换号重试。
            // WS 的安全边界比 HTTP 更晚：到这里还没有向客户端发过任何事件帧，
            // 所以换号同样对客户端透明。一旦下面的 for-await 开始 yield，就不能再换了。
            let response;
            let credIndex = -1;
            try {
                const outcome = await requestWithFailover({
                    req,
                    sessionKey,
                    model: mappedModel,
                    onFailure: (error, idx, m) => handleUpstreamRateLimit(error, idx, m),
                    send: (credential) =>
                        createChatCompletions(chatReq, {
                            credential,
                            conversationId: req.headers['x-conversation-id'],
                            sessionKey,
                            conversationRequestId: req.headers['x-conversation-request-id'],
                            conversationMessageId: req.headers['x-conversation-message-id'],
                            requestId: req.headers['x-request-id']
                        })
                });
                response = outcome.response;
                credIndex = outcome.credIndex;
            } catch (err) {
                throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
                    name: 'ResponsesWSError',
                    event: {
                        type: 'error',
                        error: {
                            message: `Upstream error: ${err?.status || 'unknown'}`,
                            code: 'upstream_error',
                            ...(buildGatewayHint(err, mappedModel)
                                ? {gateway_hint: buildGatewayHint(err, mappedModel)}
                                : {})
                        }
                    }
                });
            }

            // 将 Chat SSE 流转换为 Responses WS 事件
            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);
            let sawUpstreamErrorFrame = false;
            let receivedAnyDelta = false;
            let upstreamErrorFrame = null;
            let streamError = null;
            // 是否把上游流完整读完：被外部 return() 提前终止（客户端关闭）时为 false，
            // 此时不能记成功——那是 client-abort 语义
            let streamCompleted = false;

            try {
                for await (const chunk of response.body) {
                    if (signal?.aborted) break;
                    buffer = Buffer.concat([buffer, chunk]);
                    let start = 0;
                    let newLineIndex;
                    while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                        const line = buffer.toString('utf8', start, newLineIndex).trim();
                        start = newLineIndex + 1;
                        if (!line || line.startsWith(':') || !line.startsWith('data: ')) continue;
                        const raw = line.slice(6).trim();
                        if (raw === '[DONE]') continue;

                        let data;
                        try { data = JSON.parse(raw); } catch { continue; }

                        // 上游业务错误帧（可能伪装成正常结束）
                        if (data.error) {
                            sawUpstreamErrorFrame = true;
                            upstreamErrorFrame = data.error;
                        }
                        if (data.choices?.[0] || data.usage) receivedAnyDelta = true;

                        const events = chatChunkToResponsesEvents(data, streamState);
                        for (const ev of events) {
                            yield {type: ev.event, data: ev.data};
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                }
                streamCompleted = !signal?.aborted;
            } catch (err) {
                streamError = err;
                throw err;
            } finally {
                // 成功判定延后到流真正迭代结束（而非拿到 200 响应头就记成功）。
                // 被外部提前终止（客户端关 WS / signal.aborted）时不算成功，按 client-abort 处理。
                accountStreamOutcome({
                    credIndex,
                    model: mappedModel,
                    sessionKey,
                    affinityScope: affinityScopeOf(req),
                    error: streamError,
                    aborted: !streamCompleted,
                    sawUpstreamErrorFrame,
                    receivedAnyDelta,
                    errorFrame: upstreamErrorFrame
                });
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
}

/**
 * 主路由处理函数
 */
export async function routeCodebuddyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 凭证管理端点（两个模式共用）==========
    if (pathname.startsWith('/codebuddy/v1/credentials')) {
        return handleCredentials(req, res, method, pathname.replace('/codebuddy', ''));
    }

    // ========== Anthropic 模式（Claude 格式）==========
    if (pathname.startsWith('/codebuddy/anthropic')) {
        const anthropicPath = pathname.replace('/codebuddy/anthropic', '');

        if (anthropicPath === '/v1/messages' && method === 'POST') {
            return handleAnthropicMessages(req, res);
        }

        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') {
            return handleAnthropicCountTokens(req, res);
        }

        if (anthropicPath === '/v1/models' && method === 'GET') {
            return handleAnthropicModels(req, res);
        }

        // Anthropic 模式的根路径
        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'WorkBuddy API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /codebuddy/anthropic/v1/messages',
                    countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                    models: 'GET /codebuddy/anthropic/v1/models'
                }
            });
            return;
        }

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式（默认）==========
    // 注意：所有非 anthropic 路径都走 OpenAI 模式

    if (pathname === '/codebuddy/v1/chat/completions' && method === 'POST') {
        return handleOpenAIChatCompletions(req, res);
    }

    if (pathname === '/codebuddy/v1/responses/compact' && method === 'POST') {
        return handleResponsesCompact(req, res);
    }

    if (pathname === '/codebuddy/v1/responses' && method === 'POST') {
        return handleResponsesAPI(req, res);
    }

    if (pathname === '/codebuddy/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // OpenAI 模式的根路径
    if (pathname === '/codebuddy' || pathname === '/codebuddy/' || pathname === '/codebuddy/v1' || pathname === '/codebuddy/v1/') {
        return handleRoot(req, res);
    }

    // 未匹配到任何路由
    sendOpenAIError(res, 404, 'Endpoint not found');
}
