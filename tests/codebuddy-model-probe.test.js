import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {classifyProbeError, probeOneModel, probeAccountModels, PROBE_STATUS} from '../src/services/codebuddy/model-probe.js';
import {UpstreamNetworkError, UpstreamIdleTimeout} from '../src/utils/http-client.js';

/**
 * 模型探测的两个关键约束：
 * 1. 只有 6004/11102 是「模型不可用」；其余都是账号/渠道层面，不能算到模型头上
 * 2. WAF/排队/超时属于「测不出来」，既不算可用也不算模型坏
 */

function apiError(status, code = null, message = '') {
    return Object.assign(new Error(message || `upstream ${status}`), {status, code});
}

test('6004 是「今日额度用完」，不是模型不可用', () => {
    // 用户明确指出：V4.1 Flash 只是当天调度量用超了，明天就恢复，
    // 标成「不可用」会让人以为模型坏了。
    const v = classifyProbeError(apiError(429, 6004));
    assert.equal(v.status, PROBE_STATUS.QUOTA);
    assert.notEqual(v.status, PROBE_STATUS.MODEL_UNAVAILABLE);
});

test('11102 按 message 区分权限与模型缺失', () => {
    const forbidden = classifyProbeError(apiError(400, 11102, 'model [x] is only available for authorized users'));
    assert.equal(forbidden.status, PROBE_STATUS.MODEL_UNAVAILABLE);

    const missing = classifyProbeError(apiError(400, 11102, 'model [x] service info not found'));
    assert.equal(missing.status, PROBE_STATUS.MODEL_UNAVAILABLE);
});

test('11133（模型拒绝该请求）也归到模型不可用', () => {
    // 实测 glm-5.1 / glm-5.0-turbo 会返回它，上游自己建议「换模型」
    const result = classifyProbeError(apiError(400, 11133));
    assert.equal(result.status, PROBE_STATUS.MODEL_UNAVAILABLE);
});

test('11158（账号类型不支持该模型）归到模型不可用', () => {
    // 实测 personal_free_user 用 gpt-5.5 会返回它，上游说「当前账号类型暂不支持该模型」
    const result = classifyProbeError(apiError(400, 11158));
    assert.equal(result.status, PROBE_STATUS.MODEL_UNAVAILABLE);
    assert.match(result.detail, /11158/);
});

test('账号限流/余额不足归到账号，不算模型坏', () => {
    assert.equal(classifyProbeError(apiError(429)).status, PROBE_STATUS.ACCOUNT_LIMITED);
    assert.equal(classifyProbeError(apiError(402)).status, PROBE_STATUS.BALANCE);
    assert.equal(classifyProbeError(apiError(404)).status, PROBE_STATUS.NOT_FOUND);
});

test('渠道级错误归到渠道，不算模型坏', () => {
    assert.equal(classifyProbeError(apiError(503, 6021)).status, PROBE_STATUS.BUSY);
    // 11128 实测是「首条消息不是 system」，不是账号被封
    const waf = classifyProbeError(apiError(400, 11128));
    assert.equal(waf.status, PROBE_STATUS.WAF);
    assert.match(waf.detail, /首条消息不是 system/);
});

test('网络与超时分开归类，都不算模型坏', () => {
    assert.equal(classifyProbeError(new UpstreamNetworkError('ECONNRESET', 'ECONNRESET')).status, PROBE_STATUS.NETWORK);
    assert.equal(classifyProbeError(new UpstreamIdleTimeout('idle', 30000)).status, PROBE_STATUS.TIMEOUT);
});

test('400 与 5xx 都不算模型不可用', () => {
    const badRequest = classifyProbeError(apiError(400));
    assert.equal(badRequest.status, PROBE_STATUS.BAD_REQUEST);
    assert.equal(badRequest.status === PROBE_STATUS.MODEL_UNAVAILABLE, false);

    const server500 = classifyProbeError(apiError(500));
    assert.equal(server500.status, PROBE_STATUS.ERROR);
    assert.equal(server500.status === PROBE_STATUS.MODEL_UNAVAILABLE, false);
});

test('空错误不抛异常', () => {
    assert.equal(classifyProbeError(null).status, PROBE_STATUS.ERROR);
    assert.equal(classifyProbeError(undefined).status, PROBE_STATUS.ERROR);
});

/** 起一个可控的上游：按模型名决定返回什么 */
async function startProbeUpstream(behavior) {
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            let model = 'unknown';
            let parsed = {};
            try {
                parsed = JSON.parse(body);
                model = parsed.model || 'unknown';
            } catch {
                /* ignore */
            }
            const action = behavior(model, parsed);
            if (action.kind === 'ok') {
                res.writeHead(200, {'Content-Type': 'text/event-stream'});
                res.write(
                    `data: ${JSON.stringify({
                        id: 'p',
                        model,
                        choices: [{index: 0, delta: {content: 'x'}, finish_reason: null}]
                    })}\n\n`
                );
                res.write(
                    `data: ${JSON.stringify({
                        id: 'p',
                        model,
                        choices: [{index: 0, delta: {}, finish_reason: 'length'}],
                        usage: {prompt_tokens: 1, completion_tokens: 1, credit: 0.01}
                    })}\n\n`
                );
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            if (action.kind === 'empty') {
                res.writeHead(200, {'Content-Type': 'text/event-stream'});
                res.write(`data: ${JSON.stringify({id: 'p', model, choices: []})}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            // 错误：返回 JSON body 带 code
            res.writeHead(action.status, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({code: action.code, msg: 'nope'}));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {server, baseUrl: `http://127.0.0.1:${server.address().port}`};
}

function credentialFor(baseUrl) {
    return {bearer_token: 't', user_id: 'u', base_url: baseUrl};
}

test('探测：可用模型返回 ok，并带上耗时与 credit', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'ok'}));
    try {
        const result = await probeOneModel(credentialFor(upstream.baseUrl), 'glm-5.3', {
            connectTimeoutMs: 3000,
            idleTimeoutMs: 3000
        });
        assert.equal(result.status, PROBE_STATUS.OK);
        assert.equal(result.label, '可用');
        assert.equal(result.blameModel, false);
        assert.ok(result.elapsedMs >= 0);
        assert.equal(result.credit, 0.01);
    } finally {
        upstream.server.close();
    }
});

test('探测请求的首条消息必须是 system', async () => {
    // 上游对「首条不是 system」的请求直接回 400 + 11128，
    // 探针不带 system 就会对国际站永远测不出真实结果。
    let captured = null;
    const upstream = await startProbeUpstream((model, parsed) => {
        captured = parsed;
        return {kind: 'ok'};
    });
    try {
        await probeOneModel(credentialFor(upstream.baseUrl), 'glm-5.3', {
            connectTimeoutMs: 3000,
            idleTimeoutMs: 3000
        });
        assert.ok(captured, '上游应该收到请求');
        assert.ok(Array.isArray(captured.messages) && captured.messages.length >= 2, '至少 system + user 两条');
        assert.equal(captured.messages[0].role, 'system', '首条必须是 system');
        assert.equal(captured.messages[captured.messages.length - 1].role, 'user');
        assert.equal(captured.max_tokens, 1, '探针只要一个 token');
        // 传 '' 表示「明确关闭 thinking」，normalizePayload 会把它从请求体里删掉
        // （而不是补成默认的 'high'），所以上游收到的是 undefined。
        assert.equal(
            captured.reasoning_effort,
            undefined,
            '关掉 thinking 后上游不该收到 reasoning_effort 字段'
        );
    } finally {
        upstream.server.close();
    }
});

test('探测：额度用完标成 quota，不算模型坏', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 429, code: 6004}));
    try {
        const result = await probeOneModel(credentialFor(upstream.baseUrl), 'glm-5.3', {
            connectTimeoutMs: 3000,
            idleTimeoutMs: 3000
        });
        assert.equal(result.status, PROBE_STATUS.QUOTA);
        assert.equal(result.blameModel, false, '额度用完不该算到模型头上');
        assert.match(result.detail, /额度/);
    } finally {
        upstream.server.close();
    }
});

test('探测：权限不足标成模型不可用', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 400, code: 11158}));
    try {
        const result = await probeOneModel(credentialFor(upstream.baseUrl), 'gpt-5.5', {
            connectTimeoutMs: 3000,
            idleTimeoutMs: 3000
        });
        assert.equal(result.status, PROBE_STATUS.MODEL_UNAVAILABLE);
        assert.equal(result.blameModel, true);
    } finally {
        upstream.server.close();
    }
});

test('探测：账号余额不足不算模型坏', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 402, code: 12153}));
    try {
        const result = await probeOneModel(credentialFor(upstream.baseUrl), 'glm-5.3', {
            connectTimeoutMs: 3000,
            idleTimeoutMs: 3000
        });
        assert.equal(result.status, PROBE_STATUS.BALANCE);
        assert.equal(result.blameModel, false);
    } finally {
        upstream.server.close();
    }
});

test('探测：200 但没有内容判为「无响应」，不算不可用', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'empty'}));
    try {
        const result = await probeOneModel(credentialFor(upstream.baseUrl), 'glm-5.3', {
            connectTimeoutMs: 3000,
            idleTimeoutMs: 3000
        });
        assert.equal(result.status, PROBE_STATUS.EMPTY);
        assert.equal(result.blameModel, false);
    } finally {
        upstream.server.close();
    }
});

test('探测：上游连不上判为网络错误', async () => {
    const result = await probeOneModel(credentialFor('http://127.0.0.1:1'), 'glm-5.3', {
        connectTimeoutMs: 1500,
        idleTimeoutMs: 1500
    });
    assert.ok([PROBE_STATUS.NETWORK, PROBE_STATUS.TIMEOUT].includes(result.status), `实际：${result.status}`);
    assert.equal(result.blameModel, false);
});

test('批量探测：汇总区分 可用 / 模型不可用 / 测不出', async () => {
    const upstream = await startProbeUpstream((model) => {
        if (model === 'good') return {kind: 'ok'};
        if (model === 'blocked') return {kind: 'error', status: 400, code: 11158};
        if (model === 'waf') return {kind: 'error', status: 400, code: 11128};
        return {kind: 'empty'};
    });
    try {
        const {results, summary} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['good', 'blocked', 'waf', 'silent'],
            concurrency: 2
        });
        assert.equal(results.length, 4);
        assert.equal(summary.total, 4);
        assert.equal(summary.ok, 1);
        assert.equal(summary.failed, 1, '只有 11158（没权限）算模型不可用');
        assert.equal(summary.unknown, 2, 'WAF 与空响应都算测不出');
    } finally {
        upstream.server.close();
    }
});

test('批量探测：每测完一个就回调一次，顺序单调递增', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'ok'}));
    try {
        const seen = [];
        await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['m1', 'm2', 'm3'],
            concurrency: 1,
            onResult: (result, done, total) => seen.push({model: result.model, done, total})
        });
        assert.equal(seen.length, 3);
        assert.deepEqual(
            seen.map((s) => s.done),
            [1, 2, 3]
        );
        assert.ok(seen.every((s) => s.total === 3));
    } finally {
        upstream.server.close();
    }
});

test('批量探测：回调抛异常不会打断探测', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'ok'}));
    try {
        const {results} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['a', 'b'],
            concurrency: 1,
            onResult: () => {
                throw new Error('展示层炸了');
            }
        });
        assert.equal(results.length, 2);
    } finally {
        upstream.server.close();
    }
});

test('批量探测：空模型列表直接返回空结果', async () => {
    const {results, summary} = await probeAccountModels({credential: {}, models: []});
    assert.deepEqual(results, []);
    assert.equal(summary.total, 0);
});

test('连续账号级失败时提前收手，剩余模型标为未测试', async () => {
    // 全部返回 WAF：继续测下去只会把每个模型都标成同一个原因
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 400, code: 11128}));
    try {
        const {results, summary, aborted, abortReason} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
            concurrency: 1,
            abortAfterAccountWide: 3
        });
        assert.equal(aborted, true);
        assert.match(abortReason, /连续 3 个/);
        assert.equal(summary.notTested > 0, true, '剩下的模型不该再发请求');
        assert.equal(
            results.filter((r) => r.status === PROBE_STATUS.WAF).length,
            3
        );
    } finally {
        upstream.server.close();
    }
});

test('模型级失败（没权限）不触发提前收手', async () => {
    // 11158 是每个模型各自没权限，逐个测才有意义——不该因为连续几个就停下
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 400, code: 11158}));
    try {
        const {results, aborted, summary} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['m1', 'm2', 'm3', 'm4'],
            concurrency: 1,
            abortAfterAccountWide: 3
        });
        assert.equal(aborted, false);
        assert.equal(summary.failed, 4, '每个都该真的测过');
        assert.equal(results.length, 4);
    } finally {
        upstream.server.close();
    }
});

test('额度用完不会触发提前收手（它是模型级限制）', async () => {
    // 实测：同一账号下 deepseek-v4.1-flash 报 6004 时，deepseek-v4-pro / glm-5.3 都还能用，
    // 上游 msg 也明说「您也可以切换其他模型继续使用」。
    // 所以额度用完不能当成账号整体不可用，否则会把剩下的正常模型误标成「未测试」。
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 429, code: 6004}));
    try {
        const {aborted, summary, results} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['m1', 'm2', 'm3', 'm4', 'm5'],
            concurrency: 1,
            abortAfterAccountWide: 3
        });
        assert.equal(aborted, false, '额度用完是模型级的，不该停下');
        assert.equal(summary.notTested, 0, '每个模型都该真的测过');
        assert.equal(results.filter((r) => r.status === PROBE_STATUS.QUOTA).length, 5);
    } finally {
        upstream.server.close();
    }
});

test('提前收手可关闭（abortAfterAccountWide: 0）', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'error', status: 400, code: 11128}));
    try {
        const {aborted, summary} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['m1', 'm2', 'm3', 'm4'],
            concurrency: 1,
            abortAfterAccountWide: 0
        });
        assert.equal(aborted, false);
        assert.equal(summary.notTested, 0);
    } finally {
        upstream.server.close();
    }
});

test('中途成功后计数清零，不会误判整轮', async () => {
    let n = 0;
    const upstream = await startProbeUpstream(() => {
        n++;
        // 失败、失败、成功、失败、失败 → 成功那一下把连续计数清零
        return n === 3 ? {kind: 'ok'} : {kind: 'error', status: 400, code: 11128};
    });
    try {
        const {aborted} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['m1', 'm2', 'm3', 'm4', 'm5'],
            concurrency: 1,
            abortAfterAccountWide: 3
        });
        assert.equal(aborted, false, '中间成功过一次就不该提前收手');
    } finally {
        upstream.server.close();
    }
});

test('批量探测：非数组/含非法项时过滤掉', async () => {
    const upstream = await startProbeUpstream(() => ({kind: 'ok'}));
    try {
        const {results} = await probeAccountModels({
            credential: credentialFor(upstream.baseUrl),
            models: ['ok-model', null, '', 123],
            concurrency: 1
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].model, 'ok-model');
    } finally {
        upstream.server.close();
    }
});
