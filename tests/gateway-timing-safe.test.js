import test from 'node:test';
import assert from 'node:assert/strict';
import {_timingSafeEqualHex as timingSafeEqualHex} from '../src/services/gateway/auth.js';

/**
 * 常量时间比较的边界：长度不等、非法 hex、非字符串都不得抛错。
 */

test('相等 hex → true', () => {
    const a = 'a'.repeat(64);
    assert.equal(timingSafeEqualHex(a, a), true);
});

test('不等但等长 hex → false', () => {
    assert.equal(timingSafeEqualHex('a'.repeat(64), 'b'.repeat(64)), false);
});

test('长度不等 → false（不抛错）', () => {
    assert.equal(timingSafeEqualHex('aabb', 'aabbccdd'), false);
});

test('非法 hex / 空串 → false（不抛错）', () => {
    assert.equal(timingSafeEqualHex('', ''), false);
    assert.equal(timingSafeEqualHex('zz', 'zz'), false, '非法 hex 静默截断后长度为 0');
});

test('非字符串 → false（不抛错）', () => {
    assert.equal(timingSafeEqualHex(undefined, 'a'.repeat(64)), false);
    assert.equal(timingSafeEqualHex(null, null), false);
    assert.equal(timingSafeEqualHex({}, []), false);
});
