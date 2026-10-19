import test from 'node:test';
import assert from 'node:assert/strict';
import {realmKeyOf, pickCredentialPerRealm} from '../src/services/codebuddy/api.js';

/**
 * 站点判定的唯一职责：把凭证归到 cn / intl，供模型缓存分键。
 *
 * 这件事必须准：国内站和国际站的模型集合与倍率完全不同（实测国内站 32 个、
 * 国际站 20 个；同名模型 deepseek-v4.1-flash 在国内站 x0.11、国际站免费）。
 * 判错站点会导致回退缓存时拿出一堆对方站点的模型。
 */

test('国内站：copilot.tencent.com', () => {
    assert.equal(realmKeyOf({base_url: 'https://copilot.tencent.com'}), 'cn');
});

test('国内站：www.codebuddy.cn', () => {
    assert.equal(realmKeyOf({base_url: 'https://www.codebuddy.cn', domain: 'www.codebuddy.cn'}), 'cn');
});

test('国际站：www.codebuddy.ai', () => {
    assert.equal(realmKeyOf({base_url: 'https://www.codebuddy.ai', domain: 'www.codebuddy.ai'}), 'intl');
});

test('国际站：workbuddy.ai 也归到 intl', () => {
    assert.equal(realmKeyOf({base_url: 'https://www.workbuddy.ai'}), 'intl');
});

test('只有 domain 没有 base_url 时也能判', () => {
    assert.equal(realmKeyOf({domain: 'www.codebuddy.ai'}), 'intl');
    assert.equal(realmKeyOf({domain: 'copilot.tencent.com'}), 'cn');
});

test('字段缺失或为空时默认国内站（保守：不把未知账号当国际站）', () => {
    assert.equal(realmKeyOf({}), 'cn');
    assert.equal(realmKeyOf(null), 'cn');
    assert.equal(realmKeyOf({base_url: ''}), 'cn');
});

test('大小写不敏感', () => {
    assert.equal(realmKeyOf({base_url: 'HTTPS://WWW.CODEBUDDY.AI'}), 'intl');
    assert.equal(realmKeyOf({domain: 'WWW.CODEBUDDY.CN'}), 'cn');
});

test('国内站域名里带 ai 字样不会被误判（codebuddy.cn 不含 .ai）', () => {
    // 防回归：早期实现用 includes('ai') 判断，会把 codebuddy.cn 之外的域名误伤
    assert.equal(realmKeyOf({base_url: 'https://www.codebuddy.cn', domain: 'www.codebuddy.cn'}), 'cn');
});

// ============ pickCredentialPerRealm ============

const mk = (id, baseUrl) => ({data: {bearer_token: 't-' + id, user_id: id, base_url: baseUrl}});

test('两个站点各取一个代表账号，国内站在前', () => {
    const picked = pickCredentialPerRealm([
        mk('intl1', 'https://www.codebuddy.ai'),
        mk('cn1', 'https://copilot.tencent.com')
    ]);
    assert.equal(picked.length, 2);
    assert.equal(picked[0].realm, 'cn');
    assert.equal(picked[0].credential.user_id, 'cn1');
    assert.equal(picked[1].realm, 'intl');
    assert.equal(picked[1].credential.user_id, 'intl1');
});

test('同站点有多个号时只取第一个（代表账号够用）', () => {
    const picked = pickCredentialPerRealm([
        mk('cn1', 'https://copilot.tencent.com'),
        mk('cn2', 'https://www.codebuddy.cn'),
        mk('intl1', 'https://www.codebuddy.ai'),
        mk('intl2', 'https://www.workbuddy.ai')
    ]);
    assert.equal(picked.length, 2);
    assert.equal(picked[0].credential.user_id, 'cn1');
    assert.equal(picked[1].credential.user_id, 'intl1');
});

test('只有一个站点时只返回那一个', () => {
    const picked = pickCredentialPerRealm([mk('cn1', 'https://copilot.tencent.com')]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].realm, 'cn');
});

test('跳过没有 bearer_token 的凭证', () => {
    const picked = pickCredentialPerRealm([
        {data: {user_id: 'bad', base_url: 'https://www.codebuddy.ai'}},
        mk('intl1', 'https://www.codebuddy.ai')
    ]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].credential.user_id, 'intl1');
});

test('空输入返回空数组，不崩', () => {
    assert.deepEqual(pickCredentialPerRealm([]), []);
    assert.deepEqual(pickCredentialPerRealm(), []);
});
