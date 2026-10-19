import test from 'node:test';
import assert from 'node:assert/strict';
import {CodeBuddyApiError, upstreamErrorStatus, buildGatewayHint} from '../src/services/codebuddy/api.js';

/**
 * 上游错误分类的"末端语义"：
 * 客户端需要据此判断该换模型、重试、还是放弃。
 */

function makeErr(status, code = null) {
    return new CodeBuddyApiError(status, `HTTP ${status}`, {code, body: null});
}

test('429 保持原样返回 429', () => {
    assert.equal(upstreamErrorStatus(makeErr(429)), 429);
});

test('模型级限流 code 6004 → 400（应换模型而非重试）', () => {
    assert.equal(upstreamErrorStatus(makeErr(429, 6004)), 400);
    assert.equal(upstreamErrorStatus(makeErr(429, '6004')), 400);
});

test('无此模型 code 11102 → 400', () => {
    assert.equal(upstreamErrorStatus(makeErr(400, 11102)), 400);
    assert.equal(upstreamErrorStatus(makeErr(404, '11102')), 400);
});

test('其余上游错误 → 502', () => {
    assert.equal(upstreamErrorStatus(makeErr(402)), 502);
    assert.equal(upstreamErrorStatus(makeErr(500)), 502);
    assert.equal(upstreamErrorStatus(makeErr(503)), 502);
});

test('网络错误 → 502；其他异常 → 500', () => {
    const netErr = new Error('getaddrinfo ENOTFOUND');
    netErr.code = 'ENOTFOUND';
    assert.equal(upstreamErrorStatus(netErr), 502);
    assert.equal(upstreamErrorStatus(new Error('boom')), 500);
});

test('6004 的 hint 提示换模型，不提示重试', () => {
    const hint = buildGatewayHint(makeErr(429, 6004), 'glm-5.1');
    assert.match(hint, /glm-5\.1/);
    assert.match(hint, /其他模型/);
});

test('429 的 hint 说明会自动切凭证', () => {
    assert.match(buildGatewayHint(makeErr(429), 'x'), /切换/);
});

test('402 的 hint 说明余额与切凭证', () => {
    assert.match(buildGatewayHint(makeErr(402), 'x'), /余额|冷却/);
});

test('400 的 hint 说明换凭证无效', () => {
    assert.match(buildGatewayHint(makeErr(400), 'x'), /换凭证无效/);
});

test('5xx 的 hint 说明可稍后重试', () => {
    assert.match(buildGatewayHint(makeErr(503), 'x'), /重试/);
});

test('网络错误的 hint 提示检查网络', () => {
    const e = new Error('fetch failed');
    e.code = 'ECONNREFUSED';
    assert.match(buildGatewayHint(e, 'x'), /网络/);
});

test('无适用提示时返回空串（不编造）', () => {
    assert.equal(buildGatewayHint(new Error('unknown'), 'x'), '');
});

test('gateway_hint 绝不替换 message（仅并列补充）', () => {
    const err = makeErr(429, 6004);
    // 主错误信息保持原样
    assert.equal(err.message, 'HTTP 429');
    // hint 是独立字段
    const hint = buildGatewayHint(err, 'glm-5.1');
    assert.notEqual(hint, err.message);
});
