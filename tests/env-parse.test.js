import test from 'node:test';
import assert from 'node:assert/strict';
import {intEnv, boolEnv} from '../src/utils/env.js';

/**
 * 环境变量解析：非法值一律「告警 + 回退默认」，绝不抛异常
 * （PM2 下抛错会让 worker 反复重启、整轮任务无声炸掉）。
 */

function withEnv(name, value, fn) {
    const prev = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env[name];
        else process.env[name] = prev;
    }
}

test('intEnv：合法值正常解析', () => {
    withEnv('T_INT_A', '42', () => assert.equal(intEnv('T_INT_A', {default: 1}), 42));
});

test('intEnv：缺省返回默认', () => {
    withEnv('T_INT_B', undefined, () => assert.equal(intEnv('T_INT_B', {default: 7}), 7));
});

test('intEnv：非整数回退默认（不抛）', () => {
    withEnv('T_INT_C', 'abc', () => assert.equal(intEnv('T_INT_C', {default: 5}), 5));
});

test('intEnv：越界回退默认（不抛）', () => {
    withEnv('T_INT_D', '-1', () => assert.equal(intEnv('T_INT_D', {default: 5, min: 1}), 5));
    withEnv('T_INT_E', '99999', () => assert.equal(intEnv('T_INT_E', {default: 5, max: 100}), 5));
});

test('intEnv：小数视为非法整数', () => {
    withEnv('T_INT_F', '3.5', () => assert.equal(intEnv('T_INT_F', {default: 9}), 9));
});

test('boolEnv：真值/假值解析', () => {
    for (const v of ['1', 'true', 'YES', 'on']) {
        withEnv('T_BOOL_A', v, () => assert.equal(boolEnv('T_BOOL_A'), true));
    }
    for (const v of ['0', 'false', 'NO', 'off']) {
        withEnv('T_BOOL_B', v, () => assert.equal(boolEnv('T_BOOL_B', true), false));
    }
});

test('boolEnv：缺省/非法回退默认', () => {
    withEnv('T_BOOL_C', undefined, () => assert.equal(boolEnv('T_BOOL_C', true), true));
    withEnv('T_BOOL_D', 'maybe', () => assert.equal(boolEnv('T_BOOL_D', false), false));
});
