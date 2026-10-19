import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyStreamOutcome, shouldPenalizeCredential} from '../src/services/codebuddy/stream-outcome.js';
import {UpstreamNetworkError, UpstreamIdleTimeout} from '../src/utils/http-client.js';

/**
 * 流终态归类：决定"是否入账、是否惩罚账号"。
 * 核心约束：网络问题/客户端断开绝不罚账号；上游 error 帧与业务失败才罚。
 */

test('客户端断开 → client-abort（压过其它信号）', () => {
    assert.equal(classifyStreamOutcome({aborted: true, error: new Error('x'), sawUpstreamErrorFrame: true}), 'client-abort');
});

test('网络错误 → network', () => {
    assert.equal(classifyStreamOutcome({error: new UpstreamNetworkError('reset', 'ECONNRESET')}), 'network');
});

test('上游流空闲超时 → network（继承网络错误，不罚账号）', () => {
    const err = new UpstreamIdleTimeout('idle', 300000);
    assert.equal(classifyStreamOutcome({error: err}), 'network');
});

test('error 帧 → upstream（即使流正常 end）', () => {
    assert.equal(classifyStreamOutcome({sawUpstreamErrorFrame: true, receivedAnyDelta: true}), 'upstream');
});

test('error 帧优先级高于 success', () => {
    assert.equal(classifyStreamOutcome({sawUpstreamErrorFrame: true, receivedAnyDelta: true}), 'upstream');
});

test('非网络错误（无 error 帧）→ upstream', () => {
    assert.equal(classifyStreamOutcome({error: new Error('boom')}), 'upstream');
});

test('200 但零帧 → empty', () => {
    assert.equal(classifyStreamOutcome({receivedAnyDelta: false}), 'empty');
});

test('正常结束且有帧 → success', () => {
    assert.equal(classifyStreamOutcome({receivedAnyDelta: true}), 'success');
});

test('shouldPenalizeCredential：仅 upstream 为真', () => {
    assert.equal(shouldPenalizeCredential('upstream'), true);
    assert.equal(shouldPenalizeCredential('network'), false);
    assert.equal(shouldPenalizeCredential('client-abort'), false);
    assert.equal(shouldPenalizeCredential('empty'), false);
    assert.equal(shouldPenalizeCredential('success'), false);
});
