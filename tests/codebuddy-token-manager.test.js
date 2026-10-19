import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';

/**
 * 在临时目录里构造 N 个凭证并实例化管理器
 */
async function withManager(count, run, options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-ttm-'));
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

test('402 → 冷却到次日 04:00（reason=balance）', async () => {
    await withManager(2, (tm) => {
        const duration = TenantTokenManager.untilNext4AM();
        assert.ok(duration > 0 && duration <= 24 * 3600 * 1000);
        tm.markRateLimited(0, duration, 'balance');
        const info = tm.getRateLimitInfo(0);
        assert.equal(info.limited, true);
        assert.equal(info.reason, 'balance');
        assert.ok(info.remainingMs > 0);
    });
});

test('429 普通软冷却按连续次数指数退避，封顶 SOFT_RATE_MAX', async () => {
    await withManager(1, (tm) => {
        const d1 = tm.noteSoftRateLimit(0);
        assert.equal(d1, TenantTokenManager.SOFT_RATE_BASE);
        const d2 = tm.noteSoftRateLimit(0);
        assert.equal(d2, TenantTokenManager.SOFT_RATE_BASE * 2);
        // 连续多次后封顶
        for (let i = 0; i < 10; i++) tm.noteSoftRateLimit(0);
        const info = tm.getRateLimitInfo(0);
        assert.ok(info.remainingMs <= TenantTokenManager.SOFT_RATE_MAX);
        assert.equal(info.reason, 'soft');
    });
});

test('code 6004 模型级冷却：账号整体仍可用，切模型即恢复', async () => {
    await withManager(1, (tm) => {
        tm.markModelCooldown(0, 'glm-5.1', 60000);
        assert.equal(tm.isModelCooled(0, 'glm-5.1'), true);
        assert.equal(tm.isModelCooled(0, 'kimi-k2.6'), false);
        // 账号级未被冷却
        assert.equal(tm.isRateLimited(0), false);
    });
});

test('连续 5xx 达阈值触发熔断（reason=breaker）', async () => {
    await withManager(1, (tm) => {
        assert.equal(tm.noteFailure(0), false);
        assert.equal(tm.noteFailure(0), false);
        assert.equal(tm.noteFailure(0), true);
        assert.equal(tm.getRateLimitInfo(0).reason, 'breaker');
    });
});

test('多机制取更长者、不叠加：短冷却不覆盖长冷却', async () => {
    await withManager(1, (tm) => {
        tm.markRateLimited(0, 600000, 'balance');
        const longExpiry = tm.rateLimitedIndexes.get(0).expiry;
        tm.markRateLimited(0, 60000, 'soft');
        assert.equal(tm.rateLimitedIndexes.get(0).expiry, longExpiry);
        assert.equal(tm.rateLimitedIndexes.get(0).reason, 'balance');
    });
});

test('成功清零连续失败/软冷却计数', async () => {
    await withManager(1, (tm) => {
        tm.noteFailure(0);
        tm.noteSoftRateLimit(0);
        tm.markRateLimited(0, 60000, 'soft');
        tm.noteSuccess(0);
        assert.equal(tm.failureStreaks.has(0), false);
        assert.equal(tm.softStreaks.has(0), false);
        // 冷却标记本身不清（成功只清计数）
        assert.equal(tm.isRateLimited(0), true);
    });
});

test('会话粘性：同一 sessionKey 复用同一凭证', async () => {
    await withManager(4, (tm) => {
        tm.setRotationCount(1);
        const a1 = tm.getNextCredential({sessionKey: 'sess-A'});
        const a2 = tm.getNextCredential({sessionKey: 'sess-A'});
        const a3 = tm.getNextCredential({sessionKey: 'sess-A'});
        assert.equal(a1.user_id, a2.user_id);
        assert.equal(a2.user_id, a3.user_id);
    });
});

test('会话粘性：绑定凭证被冷却时解绑重选', async () => {
    await withManager(4, (tm) => {
        tm.setRotationCount(1);
        const a1 = tm.getNextCredential({sessionKey: 'sess-A'});
        const idx = tm.indexOfCredential(a1);
        tm.markRateLimited(idx, 60000, 'soft');
        const a2 = tm.getNextCredential({sessionKey: 'sess-A'});
        assert.notEqual(a2.user_id, a1.user_id);
        // 旧的绑定已被替换
        assert.equal(tm.sessionAffinity.get('sess-A').index, tm.indexOfCredential(a2));
    });
});

test('手动切换凭证清空全部粘性绑定', async () => {
    await withManager(4, (tm) => {
        tm.getNextCredential({sessionKey: 's1'});
        tm.getNextCredential({sessionKey: 's2'});
        assert.ok(tm.sessionAffinity.size > 0);
        tm.setManualCredential(2);
        assert.equal(tm.sessionAffinity.size, 0);
    });
});

test('兜底：全池冷却时选最早到期者，且不清空标记、不推进计数', async () => {
    await withManager(3, (tm) => {
        tm.markRateLimited(0, 300000, 'soft');
        tm.markRateLimited(1, 100000, 'soft');
        tm.markRateLimited(2, 200000, 'soft');
        const before = JSON.stringify([...tm.failureStreaks.entries()]);
        const picked = tm.getNextCredential();
        assert.equal(picked.user_id, 'u1');
        assert.equal(tm.rateLimitedIndexes.size, 3);
        assert.equal(JSON.stringify([...tm.failureStreaks.entries()]), before);
    });
});

test('删除凭证后冷却/模型冷却/计数三项下标同步平移', async () => {
    await withManager(3, (tm) => {
        tm.markRateLimited(1, 60000, 'soft');
        tm.markRateLimited(2, 60000, 'breaker');
        tm.markModelCooldown(2, 'glm-5.1', 60000);
        tm.noteFailure(2);
        tm.deleteCredential(0);
        assert.deepEqual([...tm.rateLimitedIndexes.keys()].sort(), [0, 1]);
        assert.deepEqual([...tm.modelCooldowns.keys()], ['1:glm-5.1']);
        assert.deepEqual([...tm.failureStreaks.keys()], [1]);
    });
});

test('resetRateLimit 清除冷却、模型冷却与计数，可选解禁', async () => {
    await withManager(2, (tm) => {
        tm.markRateLimited(0, 60000, 'soft');
        tm.markModelCooldown(0, 'glm-5.1', 60000);
        tm.noteFailure(0);
        tm.toggleCredentialDisable(0);
        const result = tm.resetRateLimit(0, {clearDisabled: true});
        assert.equal(result.ok, true);
        assert.equal(result.wasRateLimited, true);
        assert.equal(result.wasDisabled, true);
        assert.equal(tm.isRateLimited(0), false);
        assert.equal(tm.isModelCooled(0, 'glm-5.1'), false);
        assert.equal(tm.failureStreaks.has(0), false);
        assert.equal(tm.disabledIndexes.includes(0), false);
    });
});

test('加权策略：从未使用的凭证获得更高权重', async () => {
    await withManager(3, async (tm) => {
        // 通过 options 走 weighted 需在构造时指定，这里直接改字段更直观
        tm.selectionStrategy = 'weighted';
        tm.lastUsedAt.set(0, Date.now());
        const counts = {'u0': 0, 'u1': 0, 'u2': 0};
        for (let i = 0; i < 300; i++) {
            const c = tm.getNextCredential();
            counts[c.user_id]++;
        }
        assert.ok(counts.u1 + counts.u2 > counts.u0, `分布异常: ${JSON.stringify(counts)}`);
    });
});

test('peekCredential 不推进轮换计数', async () => {
    await withManager(3, (tm) => {
        tm.setRotationCount(1);
        const usageBefore = tm.usageCount;
        const idxBefore = tm.currentIndex;
        tm.peekCredential();
        tm.peekCredential();
        assert.equal(tm.usageCount, usageBefore);
        assert.equal(tm.currentIndex, idxBefore);
    });
});

test('模型级冷却时 getNextCredential 跳过该模型对应凭证', async () => {
    await withManager(3, (tm) => {
        tm.setRotationCount(1);
        const first = tm.getNextCredential({sessionKey: 'm'});
        const idx = tm.indexOfCredential(first);
        tm.markModelCooldown(idx, 'glm-5.1', 60000);
        const next = tm.getNextCredential({sessionKey: 'm', model: 'glm-5.1'});
        assert.notEqual(next.user_id, first.user_id);
    });
});
