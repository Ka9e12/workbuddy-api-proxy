import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldFailover, resolveMaxAttempts, DEFAULT_MAX_ATTEMPTS} from '../src/services/codebuddy/failover.js';
import {UpstreamNetworkError, UpstreamIdleTimeout} from '../src/utils/http-client.js';

/**
 * 「换不换号」的判定直接决定用户体感：
 * 该换的没换 = 卡几分钟；不该换的换了 = 白等一轮超时。
 */

function apiError(status, code = null) {
    return Object.assign(new Error(`upstream ${status}`), {status, code});
}

test('网络错误要换号', () => {
    assert.equal(shouldFailover(new UpstreamNetworkError('ECONNRESET', 'ECONNRESET')), true);
    assert.equal(shouldFailover(new UpstreamIdleTimeout('idle', 300000)), true);
});

test('5xx 要换号', () => {
    for (const status of [500, 502, 503, 504, 529]) {
        assert.equal(shouldFailover(apiError(status)), true, `${status} 应换号`);
    }
});

test('账号级状态码要换号', () => {
    assert.equal(shouldFailover(apiError(429)), true);
    assert.equal(shouldFailover(apiError(402)), true, '余额不足：换个号就能继续');
    assert.equal(shouldFailover(apiError(404)), true);
});

test('模型级不可用不换号（换号无效，换模型才有用）', () => {
    assert.equal(shouldFailover(apiError(429, 6004)), false);
    assert.equal(shouldFailover(apiError(400, '6004')), false);
    assert.equal(shouldFailover(apiError(429, 11102)), false);
    assert.equal(shouldFailover(apiError(400, '11102')), false);
});

test('渠道级错误允许换号（配合 preferDifferentSite 才有意义）', () => {
    assert.equal(shouldFailover(apiError(503, 6021)), true, '集群排队：跨站点换号有效');
    assert.equal(shouldFailover(apiError(400, 11128)), true, 'WAF 拦截：跨站点换号有效');
});

test('请求体不合法不换号', () => {
    assert.equal(shouldFailover(apiError(400)), false);
    assert.equal(shouldFailover(apiError(422)), false);
});

test('没有错误时不换号', () => {
    assert.equal(shouldFailover(null), false);
    assert.equal(shouldFailover(undefined), false);
});

test('认不出的错误保守换一次', () => {
    assert.equal(shouldFailover(new Error('something odd')), true);
});

test('单账号池不做重试（换了还是同一个号）', () => {
    assert.equal(resolveMaxAttempts(1, 2), 1);
    assert.equal(resolveMaxAttempts(0, 2), 1);
    assert.equal(resolveMaxAttempts(undefined, 2), 1);
});

test('多账号池按配置取上限，但不超过可用号数', () => {
    assert.equal(resolveMaxAttempts(2, 2), 2);
    assert.equal(resolveMaxAttempts(5, 2), 2);
    assert.equal(resolveMaxAttempts(1, 3), 1);
    assert.equal(resolveMaxAttempts(3, 3), 3);
});

test('配置非法时回落到默认值', () => {
    assert.equal(resolveMaxAttempts(3, 0), DEFAULT_MAX_ATTEMPTS);
    assert.equal(resolveMaxAttempts(3, -1), DEFAULT_MAX_ATTEMPTS);
    assert.equal(resolveMaxAttempts(3, NaN), DEFAULT_MAX_ATTEMPTS);
    assert.equal(resolveMaxAttempts(3, undefined), DEFAULT_MAX_ATTEMPTS);
});

test('默认尝试次数是 2（首次 + 一次换号）', () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS, 2);
});
