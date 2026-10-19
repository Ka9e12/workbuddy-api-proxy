import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';

/**
 * 模型锁全景视图：面板需回答"哪些模型不能用、还要锁多久"。
 * 语义边界：模型级冷却（账号仍可用）与账号级冷却（isRateLimited）是不同维度。
 */

async function withManager(count, run, options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-model-lock-'));
    try {
        await mkdir(join(dir, 'credentials'), {recursive: true});
        const now = Math.floor(Date.now() / 1000);
        for (let i = 0; i < count; i++) {
            await writeFile(
                join(dir, 'credentials', `c${i}.json`),
                JSON.stringify({bearer_token: `t${i}`, user_id: `u${i}`, created_at: now, expires_in: 999999})
            );
        }
        await run(new TenantTokenManager(dir, options));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

test('getCredentialsInfo 暴露模型级冷却清单，且不影响 isRoutable', async () => {
    await withManager(2, (tm) => {
        tm.markModelCooldown(0, 'glm-5.1', 60000);
        const info = tm.getCredentialsInfo();
        assert.equal(info[0].modelCooldowns.length, 1);
        assert.equal(info[0].modelCooldowns[0].model, 'glm-5.1');
        assert.match(info[0].modelCooldowns[0].remainingStr, /^(\d+h)?(\d+m)?(\d+s)?$/);
        // 账号仍可用（模型锁不导致不可路由）
        assert.equal(info[0].isRateLimited, false);
        assert.equal(info[0].isRoutable, true);
        // 另一个凭证无模型锁
        assert.deepEqual(info[1].modelCooldowns, []);
    });
});

test('已过期的模型冷却不出现在返回体（惰性清理）', async () => {
    await withManager(1, (tm) => {
        tm.markModelCooldown(0, 'glm-5.1', -1); // 立即过期
        const info = tm.getCredentialsInfo();
        assert.deepEqual(info[0].modelCooldowns, []);
    });
});

test('failureStreak 反映窗口内计数，成功清零', async () => {
    await withManager(1, (tm) => {
        tm.noteFailure(0);
        assert.equal(tm.getCredentialsInfo()[0].failureStreak, 1);
        assert.equal(tm.getCredentialsInfo()[0].breakerThreshold, 3);
        tm.noteSuccess(0);
        assert.equal(tm.getCredentialsInfo()[0].failureStreak, 0);
    });
});

test('getRotationInfo 暴露 modelCooldownCount', async () => {
    await withManager(2, (tm) => {
        tm.markModelCooldown(0, 'glm-5.1', 60000);
        tm.markModelCooldown(1, 'kimi-k2.6', 60000);
        assert.equal(tm.getRotationInfo().modelCooldownCount, 2);
    });
});

test('多模型冷却按剩余时间升序排列', async () => {
    await withManager(1, (tm) => {
        tm.markModelCooldown(0, 'slow', 120000);
        tm.markModelCooldown(0, 'fast', 10000);
        const models = tm.getCredentialsInfo()[0].modelCooldowns.map((c) => c.model);
        assert.deepEqual(models, ['fast', 'slow']);
    });
});
