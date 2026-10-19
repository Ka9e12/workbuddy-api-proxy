import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';

/**
 * 连续 5xx 熔断的"时间窗口"：窗口外的散点失败不该被凑成"连续 N 次"，
 * 否则几天前一次 502 会一直挂账、把可用账号误熔断。
 */

async function withManager(count, run, options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-window-'));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('窗口内连续 3 次失败 → 熔断（reason=breaker）', async () => {
    await withManager(1, (tm) => {
        assert.equal(tm.noteFailure(0), false);
        assert.equal(tm.noteFailure(0), false);
        assert.equal(tm.noteFailure(0), true);
        assert.equal(tm.getRateLimitInfo(0).reason, 'breaker');
    });
});

test('窗口外的散点失败不累计（不会误熔断）', async () => {
    // 极小窗口，sleep 越过它，模拟"几天前的失败"
    await withManager(
        1,
        async (tm) => {
            assert.equal(tm.noteFailure(0), false);
            assert.equal(tm.noteFailure(0), false);
            await sleep(30); // 越过 20ms 窗口
            // 窗口外的旧记录不再计入，这一次从 1 重新开始 → 不熔断
            assert.equal(tm.noteFailure(0), false, '窗口外散点失败不应触发熔断');
            assert.equal(tm.isRateLimited(0), false);
        },
        {breakerWindowMs: 20}
    );
});

test('窗口内累计 4 次 → 指数退避进第二档（over=1）', async () => {
    await withManager(1, (tm) => {
        tm.noteFailure(0);
        tm.noteFailure(0);
        tm.noteFailure(0); // 第 3 次触发，duration = BASE
        const firstExpiry = tm.rateLimitedIndexes.get(0).expiry;
        tm.noteFailure(0); // 第 4 次，over=1 → BASE*2
        const secondExpiry = tm.rateLimitedIndexes.get(0).expiry;
        assert.ok(secondExpiry > firstExpiry, '第 4 次应退避到更晚');
        assert.equal(secondExpiry - Date.now() > TenantTokenManager.BREAKER_BASE, true);
    });
});

test('success 清零窗口内计数', async () => {
    await withManager(1, (tm) => {
        tm.noteFailure(0);
        tm.noteFailure(0);
        tm.noteSuccess(0);
        // 清零后重新从 1 计，3 次才熔断
        assert.equal(tm.noteFailure(0), false);
        assert.equal(tm.noteFailure(0), false);
        assert.equal(tm.noteFailure(0), true);
    });
});

test('软冷却（429）同样受时间窗口约束', async () => {
    await withManager(
        1,
        async (tm) => {
            const d1 = tm.noteSoftRateLimit(0);
            assert.equal(d1, TenantTokenManager.SOFT_RATE_BASE);
            await sleep(30); // 越过软冷却窗口
            const d2 = tm.noteSoftRateLimit(0);
            // 窗口外不计入连续 → 回到第一档，而非翻倍
            assert.equal(d2, TenantTokenManager.SOFT_RATE_BASE, '窗口外应为第一档而非翻倍');
        },
        {softWindowMs: 20}
    );
});

test('兜底探测不推进软冷却连续计数', async () => {
    await withManager(1, (tm) => {
        const d = tm.noteSoftRateLimit(0, {fromFallback: true});
        assert.equal(d, TenantTokenManager.SOFT_RATE_BASE, '兜底应只施加基础冷却');
        assert.equal(tm.softStreaks.has(0), false, '兜底不应写入连续计数');
    });
});

test('删除凭证后带对象值的计数下标正确平移', async () => {
    await withManager(3, (tm) => {
        tm.noteFailure(2);
        assert.equal(tm.failureStreaks.get(2).count, 1);
        tm.deleteCredential(0);
        assert.deepEqual([...tm.failureStreaks.keys()], [1]);
        assert.equal(tm.failureStreaks.get(1).count, 1, '平移后计数结构应保持');
    });
});

test('兜底选号标记 lastPickWasFallback', async () => {
    await withManager(2, (tm) => {
        // 正常选号
        tm.getNextCredential();
        assert.equal(tm.lastPickWasFallback, false);
        // 全池冷却 → 兜底
        tm.markRateLimited(0, 60000, 'soft');
        tm.markRateLimited(1, 60000, 'soft');
        tm.getNextCredential();
        assert.equal(tm.lastPickWasFallback, true, '全池冷却应标记为兜底');
    });
});
