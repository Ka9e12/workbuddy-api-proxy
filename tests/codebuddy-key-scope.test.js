import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';

/**
 * API Key 作用域对选号的约束。
 *
 * 三条必须守住的旁路（漏一条就是完整越权）：
 * 1. 主路径：候选集构建阶段的过滤
 * 2. 手动选中 manualSelectedIndex：它不走候选集
 * 3. 全池兜底 _selectFallback：v0 冷却时直接返回，同样不看候选集
 */

async function withManager(names, run, options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-scope-'));
    try {
        await mkdir(join(dir, 'credentials'), {recursive: true});
        const now = Math.floor(Date.now() / 1000);
        for (const [i, name] of names.entries()) {
            await writeFile(
                join(dir, 'credentials', name),
                JSON.stringify({
                    bearer_token: `t${i}`,
                    user_id: `u${i}`,
                    created_at: now,
                    expires_in: 999999
                })
            );
        }
        await run(new TenantTokenManager(dir, options), dir);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

test('白名单只含 a.json 时，连续选号只会落在 a', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        for (let i = 0; i < 6; i++) {
            const cred = tm.getNextCredential({allowedFilenames: ['a.json']});
            assert.equal(cred.user_id, 'u0');
        }
    });
});

test('白名单为空数组 = 显式全禁，返回 null（不退化成分不限）', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        assert.equal(tm.getNextCredential({allowedFilenames: []}), null);
        assert.equal(tm.peekCredential({allowedFilenames: []}), null);
    });
});

test('不传 allowedFilenames 时行为与改动前一致（轮转覆盖全部）', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        const seen = new Set();
        for (let i = 0; i < 3; i++) seen.add(tm.getNextCredential({}).user_id);
        assert.equal(seen.size, 3);
    });
});

test('白名单内全部冷却时，兜底也只从白名单挑', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        // b 健康、a 冷却 → 受限 Key 只能看到 a，此刻应走兜底返回 a，绝不能回落到 b
        tm.markRateLimited(0, 600_000, 'soft');
        const cred = tm.getNextCredential({allowedFilenames: ['a.json']});
        assert.equal(cred?.user_id, 'u0', '兜底路径必须受同一约束');
        assert.equal(tm.lastPickWasFallback, true);
    });
});

test('白名单内只有被禁用的号时返回 null，不回落到白名单外', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.toggleCredentialDisable(0);
        assert.equal(tm.getNextCredential({allowedFilenames: ['a.json']}), null);
        // 对照：不限作用域时仍能拿到 b
        assert.equal(tm.getNextCredential({}).user_id, 'u1');
    });
});

test('手动选中指向白名单外时被拦，落到白名单内', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setManualCredential(2); // c，不在白名单里
        const cred = tm.getNextCredential({allowedFilenames: ['a.json']});
        assert.equal(cred.user_id, 'u0');
        // 不能顺手把用户的手动选择清掉：作用域恢复后还得回到 c
        assert.equal(tm.manualSelectedIndex, 2);
        assert.equal(tm.getNextCredential({}).user_id, 'u2');
    });
});

test('手动选中在白名单内时优先于轮转', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setManualCredential(1); // b
        for (let i = 0; i < 3; i++) {
            assert.equal(tm.getNextCredential({allowedFilenames: ['b.json', 'c.json']}).user_id, 'u1');
        }
    });
});

test('peekCredential 三个分支都受作用域约束', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        // 分支 1：手动选中
        tm.setManualCredential(1);
        assert.equal(tm.peekCredential({allowedFilenames: ['a.json']}).user_id, 'u0');

        // 分支 2：当前轮转位
        tm.clearManualSelection();
        tm.currentIndex = 1;
        assert.equal(tm.peekCredential({allowedFilenames: ['a.json']}).user_id, 'u0');

        // 分支 3：遍历首个可用
        tm.currentIndex = 1;
        tm.toggleCredentialDisable(0);
        // a 被禁用后白名单里没有可用号
        assert.equal(tm.peekCredential({allowedFilenames: ['a.json']}), null);
        // 不限作用域时能拿到 b（手动已清、轮转位是 1）
        assert.equal(tm.peekCredential().user_id, 'u1');
    });
});

test('优先级队列在白名单内仍然生效', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'b.json', 'a.json']);
        // 队首 c 不在白名单，队内下一个 b 可用 → 应选 b 而不是 a
        assert.equal(tm.getNextCredential({allowedFilenames: ['a.json', 'b.json']}).user_id, 'u1');
    });
});

test('不同 affinityScope 下同一 sessionKey 各自绑定，不互相解绑', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        // 每个作用域里都留两个以上候选，才会走到粘性绑定逻辑
        // （单账号池直接返回，不写粘性）
        const first = tm.getNextCredential({sessionKey: 's1', affinityScope: 'k1:2', allowedFilenames: ['a.json', 'b.json']});
        const second = tm.getNextCredential({sessionKey: 's1', affinityScope: 'k2:2', allowedFilenames: ['b.json', 'c.json']});
        assert.ok(first && second);

        // 两个作用域都还在，没有互相删掉对方的绑定
        assert.equal(tm.sessionAffinity.size, 2);
        const again = tm.getNextCredential({sessionKey: 's1', affinityScope: 'k1:2', allowedFilenames: ['a.json', 'b.json']});
        assert.equal(again.user_id, first.user_id, '同一作用域内粘性仍然命中');
    });
});

test('不传 affinityScope 时粘性键与旧实现一致（纯 sessionKey）', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.getNextCredential({sessionKey: 'plain-session'});
        assert.ok(tm.sessionAffinity.has('plain-session'));
    });
});

test('单账号池直接返回该账号，不写粘性也不推进轮转计数', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        const before = tm.currentIndex;
        for (let i = 0; i < 3; i++) {
            const cred = tm.getNextCredential({
                sessionKey: 'only-one',
                allowedFilenames: ['b.json']
            });
            assert.equal(cred.user_id, 'u1');
        }
        // 没有轮换可言，游标不该被这个 Key 的请求带跑
        assert.equal(tm.currentIndex, before);
        assert.equal(tm.sessionAffinity.size, 0);
    });
});

test('白名单里的文件名不存在时忽略该条，不影响其余', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        const cred = tm.getNextCredential({allowedFilenames: ['deleted.json', 'b.json']});
        assert.equal(cred.user_id, 'u1');
    });
});

test('白名单里的条目全部不存在时返回 null（不放大权限）', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        assert.equal(tm.getNextCredential({allowedFilenames: ['gone-1.json', 'gone-2.json']}), null);
    });
});

test('作用域不推进其它账号的冷却或计数', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        for (let i = 0; i < 5; i++) tm.getNextCredential({allowedFilenames: ['a.json']});
        assert.equal(tm.isRateLimited(1), false);
        assert.equal(tm.isRateLimited(0), false);
    });
});
