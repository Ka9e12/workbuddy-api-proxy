/**
 * 账号模型可用性探测
 *
 * 面板上点「测试模型」时，对某个账号逐个模型发一次最小请求，看它现在能不能用。
 *
 * 两条纪律：
 * 1. **只读探测**。这里绝不调用 noteUpstreamFailure / noteStreamOutcome / noteUpstreamSuccess，
 *    所以冷却表、失败计数、轮换游标、会话粘性全都不动。测试结果只回给面板，不进调度。
 * 2. **并发压到很低**。11128（WAF）的直接诱因就是短时间高频请求——探测本身把它打出来，
 *    整轮结果就会是清一色「被拦截」，反而测不出真实可用性。默认并发 2。
 *
 * @module services/codebuddy/model-probe
 */

import {createChatCompletions, aggregateStreamResponse, isUpstreamBusyCode, isWafBlockCode} from './api.js';
import {isNetworkError} from '../../utils/http-client.js';
import logger from '../../utils/logger.js';

/** 单个探针的首字节超时：卡死的模型不该拖住整轮 */
const DEFAULT_CONNECT_TIMEOUT_MS = 20 * 1000;
/** 单个探针的流空闲超时 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;
/** 并发上限：再高容易自己触发 11128 */
const DEFAULT_CONCURRENCY = 2;

/** 探测结果分类 */
export const PROBE_STATUS = {
    OK: 'ok',
    MODEL_UNAVAILABLE: 'model_unavailable',
    /** 今日额度用完：不是不可用，明天就恢复 */
    QUOTA: 'quota',
    ACCOUNT_LIMITED: 'account_limited',
    BALANCE: 'balance',
    NOT_FOUND: 'not_found',
    BUSY: 'busy',
    WAF: 'waf',
    TIMEOUT: 'timeout',
    NETWORK: 'network',
    EMPTY: 'empty',
    BAD_REQUEST: 'bad_request',
    ERROR: 'error',
    /** 账号整体不可用，提前收手后剩下的模型 */
    NOT_TESTED: 'not_tested'
};

/** 每类结果的展示文案与「是否归咎于模型」 */
const STATUS_META = {
    [PROBE_STATUS.OK]: {label: '可用', blameModel: false, severity: 'ok'},
    [PROBE_STATUS.MODEL_UNAVAILABLE]: {label: '模型不可用', blameModel: true, severity: 'bad'},
    [PROBE_STATUS.QUOTA]: {label: '今日额度用完', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.ACCOUNT_LIMITED]: {label: '账号限流', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.BALANCE]: {label: '余额不足', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.NOT_FOUND]: {label: '上游 404', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.BUSY]: {label: '渠道排队', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.WAF]: {label: 'WAF 拦截', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.TIMEOUT]: {label: '超时', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.NETWORK]: {label: '网络错误', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.EMPTY]: {label: '无响应', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.BAD_REQUEST]: {label: '请求被拒', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.ERROR]: {label: '未知错误', blameModel: false, severity: 'warn'},
    [PROBE_STATUS.NOT_TESTED]: {label: '未测试', blameModel: false, severity: 'skip'}
};

/**
 * 把一次探测的异常归类
 *
 * 关键区分（和 model-permissions.js 保持一致）：
 * - 权限类（11158、11102+authorized）：账号没这个模型的权限 → 模型不可用
 * - 模型缺失（11133、11102+not found）：上游没有这个模型 → 模型不可用
 * - 额度类（6004）：今天用超了，明天恢复 → **不算不可用**，单独标出来
 * - 其余是账号或渠道层面的问题，不该算到模型头上
 *
 * @param {Error} error
 * @returns {{status: string, detail: string}}
 */
export function classifyProbeError(error) {
    if (!error) return {status: PROBE_STATUS.ERROR, detail: 'unknown'};

    const code = error.code;
    const status = Number(error.status);
    const message = String(error.message || '');

    // 额度用完：不是「不可用」，是「今天用完了」。单独一个状态，
    // 面板不会把它标灰，用户也不会以为模型坏了。
    if (code === 6004 || code === '6004') {
        const reset = message.match(/将在\s*(.+?)\s*重置/);
        return {
            status: PROBE_STATUS.QUOTA,
            kind: 'quota',
            detail: reset ? `今日额度已用完，${reset[1]} 重置` : '今日额度已用完，稍后会自动恢复'
        };
    }
    // 11102 有两种含义，靠 message 区分：权限不足 vs 模型不存在
    if (code === 11102 || code === '11102') {
        if (/only available for authorized users/i.test(message)) {
            return {status: PROBE_STATUS.MODEL_UNAVAILABLE, kind: 'forbidden', detail: '当前账号不支持该模型（需更高套餐或授权）'};
        }
        if (/service info not found/i.test(message)) {
            return {status: PROBE_STATUS.MODEL_UNAVAILABLE, kind: 'missing', detail: '上游没有这个模型（可能是配置变更）'};
        }
        return {status: PROBE_STATUS.MODEL_UNAVAILABLE, kind: 'forbidden', detail: '上游拒绝了这个模型'};
    }
    // 11133：上游明确说「这个模型无法处理该请求」，并建议换模型。
    // 实测 glm-5.1 / glm-5.0-turbo 会返回它，属于模型侧拒单，不是探针请求写错了。
    if (code === 11133 || code === '11133') {
        return {status: PROBE_STATUS.MODEL_UNAVAILABLE, kind: 'missing', detail: '模型拒绝了该请求（code 11133），上游建议换模型'};
    }
    // 11158：账号类型不支持该模型（如 personal_free_user 用不了 gpt-5.5）。
    // 对这个账号来说这个模型就是用不了，归到模型不可用——但和额度无关，换账号可能可用。
    if (code === 11158 || code === '11158') {
        return {status: PROBE_STATUS.MODEL_UNAVAILABLE, kind: 'forbidden', detail: '当前账号类型不支持该模型（code 11158）'};
    }
    // 6021：推理集群排队打满，渠道级容量事件，与账号和模型都无关
    if (isUpstreamBusyCode(code)) {
        return {status: PROBE_STATUS.BUSY, detail: '推理集群排队已满（code 6021），与模型无关，稍后重试'};
    }
    // 11128 的真实含义：首条消息不是 system（msg: "first message is not system prompt"）。
    // 这不是 WAF，也不是账号问题。探针已经带上 system 首条，若还出现说明上游规则又变了。
    if (isWafBlockCode(code)) {
        return {
            status: PROBE_STATUS.WAF,
            detail: '上游拒绝了本次请求（code 11128）。实测该码表示「首条消息不是 system」，不是账号被封'
        };
    }
    if (isNetworkError(error)) {
        // 超时类单独标出来：它往往是"模型慢/卡住"，和连不上的处置不同。
        // 同时按错误类（UpstreamIdleTimeout 的名字里没有 timeout 字样）和消息文本判断。
        const isTimeout =
            error.name === 'UpstreamIdleTimeout' ||
            error.code === 'ETIMEDOUT' ||
            /timeout|timed out|idle/i.test(error.message || '');
        return {
            status: isTimeout ? PROBE_STATUS.TIMEOUT : PROBE_STATUS.NETWORK,
            detail: error.message || '网络错误'
        };
    }
    if (status === 402) return {status: PROBE_STATUS.BALANCE, detail: '账号余额不足'};
    if (status === 429) return {status: PROBE_STATUS.ACCOUNT_LIMITED, detail: '账号被限流'};
    if (status === 404) return {status: PROBE_STATUS.NOT_FOUND, detail: '上游返回 404'};
    if (status === 400) return {status: PROBE_STATUS.BAD_REQUEST, detail: error.message || '请求被上游拒绝'};
    if (Number.isFinite(status) && status >= 500) {
        return {status: PROBE_STATUS.ERROR, detail: `上游 ${status}`};
    }
    return {status: PROBE_STATUS.ERROR, detail: error.message || '未知错误'};
}

/**
 * 探测单个模型
 *
 * @param {Object} credential - 账号凭证数据（tm.credentials[index].data）
 * @param {string} model
 * @param {Object} [opts]
 * @returns {Promise<{model: string, status: string, label: string, severity: string, detail: string, elapsedMs: number, credit: number}>}
 */
export async function probeOneModel(credential, model, opts = {}) {
    const startedAt = Date.now();
    const connectTimeout = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const idleTimeout = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    try {
        const response = await createChatCompletions(
            {
                model,
                // 首条必须是 system：上游对「第一条消息不是 system」的请求
                // 直接回 400 + code 11128（msg: "first message is not system prompt"）。
                // 这一点很容易误判成 WAF/客户端校验失败——实测把 system 补上后 11128 立刻消失，
                // 所以探针必须带它，否则对国际站永远测不出真实结果。
                messages: [
                    {role: 'system', content: 'You are a helpful assistant.'},
                    {role: 'user', content: 'ping'}
                ],
                // 只要一个 token：探针的目的是确认这条链路通不通，不是要回答
                max_tokens: 1,
                // 显式清空 reasoning_effort：否则 normalizePayload 会补 'high'，
                // 推理模型先吐一堆 thinking token 才轮到 max_tokens 截断，白白变慢
                reasoning_effort: ''
            },
            {
                credential,
                // 每个探针独立会话 ID，避免互相污染上游前缀缓存
                conversationId: `probe-${model}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
                timeout: connectTimeout,
                idleTimeout
            }
        );

        const aggregated = await aggregateStreamResponse(response.body);
        const hasContent = Boolean(
            (aggregated.content && aggregated.content.length > 0) ||
                (aggregated.reasoningContent && aggregated.reasoningContent.length > 0) ||
                (Array.isArray(aggregated.toolCalls) && aggregated.toolCalls.length > 0)
        );
        const hasFinish = Boolean(aggregated.finishReason);

        // 200 但一帧有效内容都没有：上游静默失败，不能算"模型不可用"，只能说测不出来
        if (!hasContent && !hasFinish) {
            return build(PROBE_STATUS.EMPTY, model, '200 但没有任何内容', startedAt, aggregated.usage);
        }
        return build(PROBE_STATUS.OK, model, hasFinish ? `finish: ${aggregated.finishReason}` : '收到内容', startedAt, aggregated.usage);
    } catch (error) {
        const {status, detail, kind} = classifyProbeError(error);
        logger.debug(`[CodeBuddy probe] ${model} → ${status}: ${detail}`);
        return build(status, model, detail, startedAt, null, error?.code ?? null, kind ?? null);
    }
}

/**
 * 组装单条结果
 */
function build(status, model, detail, startedAt, usage, code = null, kind = null) {
    const meta = STATUS_META[status] || STATUS_META[PROBE_STATUS.ERROR];
    return {
        model,
        status,
        label: meta.label,
        severity: meta.severity,
        blameModel: meta.blameModel,
        // 带上上游业务码与归类：路由层据此决定记成 forbidden / missing / quota，
        // 不同 kind 的缓存时长和在面板上的展示都不一样。
        code,
        kind,
        detail,
        elapsedMs: Date.now() - startedAt,
        credit: usage?.credit || 0
    };
}

/**
 * 限制并发地跑一组任务
 *
 * 项目里没有 p-limit 之类的工具，这里手写一个 worker 池。
 * 不用 Promise.all 一次性全发：31 个模型同时打上去必然触发 11128。
 *
 * @param {Array} items
 * @param {number} limit
 * @param {Function} fn
 * @returns {Promise<Array>}
 */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({length: Math.min(Math.max(1, limit), items.length)}, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * 这些状态意味着「账号整体现在不可用」，与具体模型无关。
 * 连续撞上它们时应该尽早收手：继续测下去只会把 20 多个模型全标成同一个原因，
 * 既浪费一轮探测的时间，也可能让 WAF 封得更久。
 *
 * 注意 6004（额度用完）**不在**这里：实测它是按「账号 + 模型」独立计时的，
 * 同一账号下 deepseek-v4.1-flash 报 6004 时，deepseek-v4-pro / glm-5.3 都还能用，
 * 上游 msg 也明说「您也可以切换其他模型继续使用」。把它当账号级问题会导致
 * 连续测到 3 个额度用完的模型就提前收手，剩下正常的模型被误标成「未测试」。
 */
const ACCOUNT_WIDE_STATUSES = new Set([
    PROBE_STATUS.WAF,
    PROBE_STATUS.BUSY,
    PROBE_STATUS.BALANCE,
    PROBE_STATUS.ACCOUNT_LIMITED,
    PROBE_STATUS.NETWORK,
    PROBE_STATUS.TIMEOUT
]);

/**
 * 探测一个账号的全部模型
 *
 * @param {Object} params
 * @param {Object} params.credential - 账号凭证
 * @param {string[]} params.models - 模型 id 列表
 * @param {number} [params.concurrency]
 * @param {Function} [params.onResult] - 每测完一个就回调一次，供面板流式显示
 * @param {number} [params.abortAfterAccountWide] - 连续这么多个「账号级」失败就提前收手；
 *        默认 3。设为 0 关闭
 * @returns {Promise<{results: Array, summary: Object, aborted: boolean, abortReason: string}>}
 */
export async function probeAccountModels({
    credential,
    models,
    concurrency = DEFAULT_CONCURRENCY,
    onResult,
    abortAfterAccountWide = 3
}) {
    const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : [];
    if (list.length === 0) {
        return {
            results: [],
            summary: {total: 0, ok: 0, failed: 0, unknown: 0, notTested: 0, totalCredit: 0},
            aborted: false,
            abortReason: ''
        };
    }

    let done = 0;
    let consecutiveAccountWide = 0;
    let aborted = false;
    let abortReason = '';

    // 提前收手用：一旦判定账号整体不可用，剩下的模型不再发请求。
    // 直接标成 not_tested，让面板知道「不是这些模型有问题，是没测」。
    const results = await mapLimit(list, concurrency, async (model) => {
        if (aborted) {
            const meta = STATUS_META[PROBE_STATUS.NOT_TESTED];
            return {
                model,
                status: PROBE_STATUS.NOT_TESTED,
                label: meta.label,
                severity: meta.severity,
                blameModel: meta.blameModel,
                detail: '账号整体不可用，已提前结束探测',
                elapsedMs: 0,
                credit: 0
            };
        }

        const result = await probeOneModel(credential, model);
        done++;

        if (ACCOUNT_WIDE_STATUSES.has(result.status)) {
            consecutiveAccountWide++;
            if (abortAfterAccountWide > 0 && consecutiveAccountWide >= abortAfterAccountWide && !aborted) {
                aborted = true;
                abortReason = `连续 ${consecutiveAccountWide} 个模型都返回「${result.label}」，判断是账号整体不可用而非模型问题，已提前结束`;
            }
        } else {
            consecutiveAccountWide = 0;
        }

        if (onResult) {
            try {
                onResult(result, done, list.length);
            } catch {
                // 回调是展示层的事，不能让它把探测打断
            }
        }
        return result;
    });

    const ok = results.filter((r) => r.status === PROBE_STATUS.OK).length;
    const blameModel = results.filter((r) => r.blameModel).length;
    const notTested = results.filter((r) => r.status === 'not_tested').length;
    // 「测不出来」的（WAF/排队/网络/超时/无响应）既不算可用也不算模型坏
    const unknown = results.length - ok - blameModel - notTested;

    return {
        results,
        aborted,
        abortReason,
        summary: {
            total: results.length,
            ok,
            failed: blameModel,
            unknown,
            notTested,
            totalCredit: results.reduce((sum, r) => sum + (r.credit || 0), 0)
        }
    };
}
