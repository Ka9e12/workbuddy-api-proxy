import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';
import {credentialStore} from '../src/services/codebuddy/credential-store.js';
import {noteUpstreamFailure} from '../src/services/codebuddy/auth.js';
import {upstreamErrorStatus, buildGatewayHint, CodeBuddyApiError, isUpstreamBusyCode, isWafBlockCode} from '../src/services/codebuddy/api.js';

/**
 * 在临时目录构造 N 个凭证。
 * 注意这里用真实目录而不是 mock store，因为要验证的正是"冷却状态有没有被写进去"。
 */
async function withManager(count, run) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-channel-'));
    const original = credentialStore.tokenManager;
    try {
        await mkdir(join(dir, 'credentials'), {recursive: true});
        const now = Math.floor(Date.now() / 1000);
        for (let i = 0; i < count; i++) {
            await writeFile(
                join(dir, 'credentials', `c${i}.json`),
                JSON.stringify({bearer_token: `t${i}`, user_id: `u${i}`, created_at: now, expires_in: 999999})
            );
        }
        const tm = new TenantTokenManager(dir);
        // noteUpstreamFailure 内部走 credentialStore 单例，注入临时实例
        credentialStore.tokenManager = tm;
        await run(tm);
    } finally {
        credentialStore.tokenManager = original;
        await rm(dir, {recursive: true, force: true});
    }
}

test('6021 被识别为渠道排队', () => {
    assert.equal(isUpstreamBusyCode(6021), true);
    assert.equal(isUpstreamBusyCode('6021'), true);
    assert.equal(isUpstreamBusyCode(6004), false);
    assert.equal(isUpstreamBusyCode(null), false);
});

test('11128 被识别为 WAF 拦截', () => {
    assert.equal(isWafBlockCode(11128), true);
    assert.equal(isWafBlockCode('11128'), true);
    assert.equal(isWafBlockCode(6021), false);
    assert.equal(isWafBlockCode(undefined), false);
});

test('6021 映射为 503（客户端应退避重试，不是换凭证）', () => {
    const err = new CodeBuddyApiError(429, 'queue.full.title', {code: 6021});
    assert.equal(upstreamErrorStatus(err), 503);
});

test('11128 映射为 503', () => {
    const err = new CodeBuddyApiError(400, 'request illegal', {code: 11128});
    assert.equal(upstreamErrorStatus(err), 503);
});

test('普通 429（无 code）仍是 429', () => {
    const err = new CodeBuddyApiError(429, 'too many requests', {});
    assert.equal(upstreamErrorStatus(err), 429);
});

test('6004 仍是 400（换模型，别重试）', () => {
    const err = new CodeBuddyApiError(429, 'model limit', {code: 6004});
    assert.equal(upstreamErrorStatus(err), 400);
});

test('6021 的 gateway_hint 说清"与账号无关、未冷却"', () => {
    const err = new CodeBuddyApiError(429, 'queue.full.title', {code: 6021});
    const hint = buildGatewayHint(err, 'deepseek-v4-pro');
    assert.match(hint, /6021/);
    assert.match(hint, /与账号无关/);
    assert.match(hint, /未冷却/);
});

test('11128 的 gateway_hint 提醒别频繁重试', () => {
    const err = new CodeBuddyApiError(400, 'request illegal', {code: 11128});
    const hint = buildGatewayHint(err, 'gemini-3.5-flash');
    assert.match(hint, /11128/);
    assert.match(hint, /频繁重试会延长封锁/);
});

test('6021 不冷却账号：整池不会被一次排队事件打成不可用', async () => {
    await withManager(3, (tm) => {
        // 模拟一次排队事件作用于每个账号
        for (const i of [0, 1, 2]) {
            noteUpstreamFailure(new CodeBuddyApiError(429, 'queue.full.title', {code: 6021}), i, 'deepseek-v4-pro');
        }
        // 三个号都必须仍然可路由——否则整池 10 分钟不可用
        assert.deepEqual([0, 1, 2].map((i) => tm.isRateLimited(i)), [false, false, false]);
        assert.equal(tm.softStreaks.size, 0);
        for (const i of [0, 1, 2]) {
            assert.ok(tm.getNextCredential({}), '仍有可用凭证');
        }
    });
});

test('11128 不冷却账号', async () => {
    await withManager(1, (tm) => {
        noteUpstreamFailure(new CodeBuddyApiError(400, 'request illegal', {code: 11128}), 0, 'gemini-3.5-flash');
        assert.equal(tm.isRateLimited(0), false);
        assert.equal(tm.softStreaks.size, 0);
        assert.equal(tm.modelCooldowns.size, 0);
    });
});

test('对照：真 429（无 code）仍然冷却账号并推进退避', async () => {
    await withManager(1, (tm) => {
        noteUpstreamFailure(new CodeBuddyApiError(429, 'too many requests', {}), 0, 'glm-5.0');
        assert.equal(tm.isRateLimited(0), true);
        assert.equal(tm.softStreaks.size, 1);
    });
});

test('对照：6004 只锁模型，账号仍可路由', async () => {
    await withManager(1, (tm) => {
        noteUpstreamFailure(new CodeBuddyApiError(429, 'model limit', {code: 6004}), 0, 'glm-5.0');
        assert.equal(tm.isModelCooled(0, 'glm-5.0'), true);
        assert.equal(tm.isRateLimited(0), false);
    });
});

test('6021 / 11128 与 6004 互不干扰：模型锁只由 6004 触发', async () => {
    await withManager(1, (tm) => {
        tm.markModelCooldown(0, 'glm-5.0', 60000);
        assert.equal(tm.isModelCooled(0, 'glm-5.0'), true);
        assert.equal(tm.isModelCooled(0, 'gpt-5.5'), false);
        // 账号整体仍可用
        assert.equal(tm.isRateLimited(0), false);
    });
});
