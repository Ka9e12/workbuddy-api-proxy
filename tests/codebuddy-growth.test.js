import test from 'node:test';
import assert from 'node:assert/strict';
import {decideDepart, decideClaim, decideRedeemable} from '../src/services/codebuddy/growth.js';

/**
 * 成长中心的"前置门控"是安全核心：只有状态确实满足才发写请求。
 * 这些纯函数决策决定了每个动作是否真的会触达上游，因此单独测试。
 */

test('decideDepart：无猫时跳过', () => {
    assert.equal(decideDepart({hasBuddy: false}, {state: 'idle', dailyLimitReached: false}).action, 'skip');
});

test('decideDepart：旅行中/已到站/名额用完/非 idle 均跳过', () => {
    assert.equal(decideDepart({hasBuddy: true}, {state: 'traveling'}).action, 'skip');
    assert.equal(decideDepart({hasBuddy: true}, {state: 'arrived'}).action, 'skip');
    assert.equal(decideDepart({hasBuddy: true}, {state: 'idle', dailyLimitReached: true}).action, 'skip');
    assert.equal(decideDepart({hasBuddy: true}, {state: 'weird'}).action, 'skip');
});

test('decideDepart：有猫 + idle + 未达上限 → 派出', () => {
    assert.equal(decideDepart({hasBuddy: true}, {state: 'idle', dailyLimitReached: false}).action, 'depart');
});

test('decideClaim：仅 arrived 且有 record_id 才领取', () => {
    assert.equal(decideClaim({state: 'idle', recordId: 0}).action, 'skip');
    assert.equal(decideClaim({state: 'traveling', recordId: 0}).action, 'skip');
    assert.equal(decideClaim({state: 'arrived', recordId: 0}).action, 'skip');
    assert.equal(decideClaim({state: 'arrived', recordId: 123}).action, 'claim');
});

test('decideRedeemable：只挑 unlocked/available 的档位', () => {
    const tiers = [
        {tier: '7d', status: 'locked'},
        {tier: '14d', status: 'unlocked'},
        {tier: '28d', status: 'available'},
        {tier: '7d', status: 'claimed'}
    ];
    const r = decideRedeemable(tiers);
    assert.deepEqual(r.map((t) => t.tier), ['14d', '28d']);
});

test('decideRedeemable：空输入返回空数组', () => {
    assert.deepEqual(decideRedeemable([]), []);
    assert.deepEqual(decideRedeemable(null), []);
});
