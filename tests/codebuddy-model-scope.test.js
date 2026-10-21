import test from 'node:test';
import assert from 'node:assert/strict';
import {pickScopedModelTargets, mergeModelResults} from '../src/services/codebuddy/model-scope.js';

/**
 * 模型列表的作用域收窄。
 *
 * 核心约束：分组键是上游 baseUrl 而不是 realm —— realm 只有 cn/intl 二值，
 * 企业站会落进 cn，用 realm 分组会把「只勾了某个国内站账号」的 Key
 * 也带出企业站的模型。
 */

const CN_HOST = 'https://copilot.tencent.com';
const INTL_HOST = 'https://www.codebuddy.ai';

/**
 * 构造一个最小可用的 manager 替身（只用到 credentials / disabledIndexes / 两个方法）
 */
function fakeManager(entries, overrides = {}) {
    return {
        credentials: entries.map(([filename, data]) => ({
            filePath: `/creds/${filename}`,
            data: {bearer_token: 't', ...data}
        })),
        disabledIndexes: [],
        isTokenExpired: () => false,
        isRateLimited: () => false,
        ...overrides
    };
}

test('不限作用域时同站点的每个账号都各自成为一个目标', () => {
    // 按「站点 + 账号」分组而不是只按站点：模型权限是按账号记录的，
    // 只取站点代表会把「A 号没权限」误算成「B 号也没权限」。
    const tm = fakeManager([
        ['a.json', {user_id: 'u1', base_url: CN_HOST}],
        ['b.json', {user_id: 'u2', base_url: CN_HOST}],
        ['c.json', {user_id: 'u3', base_url: INTL_HOST}]
    ]);
    const targets = pickScopedModelTargets(tm, null);
    assert.equal(targets.length, 3);
    assert.deepEqual(
        targets.map((t) => t.account).sort(),
        ['a.json', 'b.json', 'c.json']
    );
    // 每个目标都带回自己的 baseUrl，供后续按站点归类
    assert.equal(targets.filter((t) => t.baseUrl === CN_HOST).length, 2);
});

test('只勾国内站账号时只返回国内站目标 —— 国际站模型不会被带出来', () => {
    const tm = fakeManager([
        ['cn-1.json', {user_id: 'u1', base_url: CN_HOST}],
        ['intl-1.json', {user_id: 'u2', base_url: INTL_HOST}]
    ]);
    const targets = pickScopedModelTargets(tm, ['cn-1.json']);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].baseUrl, CN_HOST);
    assert.equal(targets[0].credential.user_id, 'u1');
});

test('勾了多个站点时两个都返回', () => {
    const tm = fakeManager([
        ['cn-1.json', {user_id: 'u1', base_url: CN_HOST}],
        ['intl-1.json', {user_id: 'u2', base_url: INTL_HOST}]
    ]);
    const targets = pickScopedModelTargets(tm, ['cn-1.json', 'intl-1.json']);
    assert.equal(targets.length, 2);
});

test('空数组 = 显式全禁，没有任何目标', () => {
    const tm = fakeManager([['a.json', {base_url: CN_HOST}]]);
    assert.deepEqual(pickScopedModelTargets(tm, []), []);
});

test('白名单里的文件名都不存在时不放大成全部', () => {
    const tm = fakeManager([
        ['a.json', {base_url: CN_HOST}],
        ['b.json', {base_url: INTL_HOST}]
    ]);
    assert.deepEqual(pickScopedModelTargets(tm, ['gone.json']), []);
});

test('已禁用与已过期的账号不参与', () => {
    const tm = fakeManager(
        [
            ['a.json', {base_url: CN_HOST}],
            ['b.json', {base_url: INTL_HOST}]
        ],
        {disabledIndexes: [0], isTokenExpired: (data) => data.base_url === INTL_HOST}
    );
    assert.deepEqual(pickScopedModelTargets(tm, null), []);
});

test('冷却中的账号仍可作代表（拉模型只读，不占上游用量）', () => {
    const tm = fakeManager([['a.json', {user_id: 'u1', base_url: CN_HOST}]], {
        isRateLimited: () => true
    });
    const targets = pickScopedModelTargets(tm, null);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].credential.user_id, 'u1');
});

test('同站点的多个账号都保留，冷却的排在后面', () => {
    const tm = fakeManager(
        [
            ['cooling.json', {user_id: 'cooling', base_url: CN_HOST}],
            ['healthy.json', {user_id: 'healthy', base_url: CN_HOST}]
        ],
        {isRateLimited: (i) => i === 0}
    );
    const targets = pickScopedModelTargets(tm, null);
    // 两个号都可能是某个模型的唯一来源，不能因为冷却就丢掉
    assert.equal(targets.length, 2);
    assert.equal(targets[0].credential.user_id, 'healthy', '完全可用的排前面');
    assert.equal(targets[1].credential.user_id, 'cooling');
});

test('缺少 bearer_token 的条目被跳过', () => {
    const tm = fakeManager([['empty.json', {bearer_token: null, base_url: CN_HOST}]]);
    assert.deepEqual(pickScopedModelTargets(tm, null), []);
});

test('mergeModelResults 按 id 去重，保留首次出现的条目', () => {
    const merged = mergeModelResults([
        {status: 'fulfilled', value: {models: [{id: 'glm-5.3', name: 'GLM 国内', vendor: 'zhipu'}]}},
        {status: 'fulfilled', value: {models: [{id: 'glm-5.3', name: 'GLM 国际', vendor: 'zhipu'}, {id: 'gpt-5.5', name: 'GPT', vendor: 'gpt'}]}}
    ]);
    assert.deepEqual(
        merged.map((m) => m.id),
        ['glm-5.3', 'gpt-5.5']
    );
    assert.equal(merged[0].name, 'GLM 国内');
});

test('mergeModelResults 跳过失败的分支，其余照常返回', () => {
    const merged = mergeModelResults([
        {status: 'rejected', reason: new Error('network')},
        {status: 'fulfilled', value: {models: [{id: 'kimi-k3', name: 'Kimi', vendor: 'moonshot'}]}}
    ]);
    assert.deepEqual(
        merged.map((m) => m.id),
        ['kimi-k3']
    );
});

test('mergeModelResults 忽略缺 id 的条目', () => {
    const merged = mergeModelResults([
        {status: 'fulfilled', value: {models: [{name: 'no id'}, {id: ''}, {id: 'ok', name: 'OK'}]}}
    ]);
    assert.deepEqual(
        merged.map((m) => m.id),
        ['ok']
    );
});

test('mergeModelResults 空输入返回空数组', () => {
    assert.deepEqual(mergeModelResults([]), []);
    assert.deepEqual(mergeModelResults(undefined), []);
});
