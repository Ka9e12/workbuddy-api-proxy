import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';

/**
 * 在临时目录里构造凭证并实例化管理器。
 * names 显式指定文件名，便于断言"按文件名排序"这件事本身。
 */
async function withManager(names, run, options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-priority-'));
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

test('未设置优先级时保持原轮转行为（priorityOrder 为空）', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        assert.deepEqual(tm.priorityOrder, []);
        // rotationCount=1：每次请求都换号，连续 3 次应覆盖到不同凭证
        const seen = new Set();
        for (let i = 0; i < 3; i++) {
            seen.add(tm.getNextCredential({}).user_id);
        }
        assert.equal(seen.size, 3);
    });
});

test('设置优先级后严格按顺序选号，不再轮转', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        assert.equal(tm.setPriorityOrder(['c.json', 'a.json', 'b.json']), true);
        // 连续 5 次都必须落在排第一的 c（下标 2）
        for (let i = 0; i < 5; i++) {
            assert.equal(tm.getNextCredential({}).user_id, 'u2');
        }
    });
});

test('队首冷却时顺延到下一个，恢复后立刻回到队首', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);

        tm.markRateLimited(2, 60_000, 'soft');
        assert.equal(tm.getNextCredential({}).user_id, 'u0'); // 顺延到 a

        // 队首和 a 都不可用 → b
        tm.markRateLimited(0, 60_000, 'soft');
        assert.equal(tm.getNextCredential({}).user_id, 'u1');

        // 队首恢复后立刻回到它，不需要等轮转
        tm.resetRateLimit(2);
        assert.equal(tm.getNextCredential({}).user_id, 'u2');
    });
});

test('禁用的队首被跳过', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.setPriorityOrder(['b.json', 'a.json']);
        tm.toggleCredentialDisable(1);
        assert.equal(tm.getNextCredential({}).user_id, 'u0');
    });
});

test('优先级跨重启保留（存 state.json）', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], async (tm, dir) => {
        tm.setPriorityOrder(['b.json', 'c.json', 'a.json']);

        const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
        assert.deepEqual(state.priorityOrder, ['b.json', 'c.json', 'a.json']);

        // 新实例读同一目录，顺序照旧生效
        const fresh = new TenantTokenManager(dir);
        assert.deepEqual(fresh.priorityOrder, ['b.json', 'c.json', 'a.json']);
        assert.equal(fresh.getNextCredential({}).user_id, 'u1');
    });
});

test('删除凭证后顺序自动收敛，不留幽灵项', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);
        tm.deleteCredential(2); // 删掉 c

        // c 已经不在了，不能还排在队首，也不能留在数组里
        for (let i = 0; i < 3; i++) {
            assert.equal(tm.getNextCredential({}).user_id, 'u0'); // a
        }
        assert.ok(!tm.priorityOrder.includes('c.json'));
        assert.equal(tm.priorityOrder.length, 2);
    });
});

test('新加的凭证自动补到队尾，不会因为没排过队而被饿死', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.setPriorityOrder(['b.json', 'a.json']);

        tm.addCredentialWithData({
            bearer_token: 't-new',
            user_id: 'u-new',
            created_at: Math.floor(Date.now() / 1000),
            expires_in: 999999
        });

        // 队首仍是 b
        const first = tm.getNextCredential({});
        assert.equal(first.user_id, 'u1');

        // 新号在队尾，前两个都禁用后能轮到它
        const newIdx = tm.credentials.findIndex((c) => c.data.user_id === 'u-new');
        assert.ok(newIdx >= 0);
        assert.equal(tm.priorityOrder[tm.priorityOrder.length - 1], tm.credentials[newIdx].filePath.split(/[\\/]/).pop());
    });
});

test('传入未知文件名被忽略，不会破坏既有顺序', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.setPriorityOrder(['b.json', 'a.json']);
        const ok = tm.setPriorityOrder(['ghost.json', 'a.json']);
        assert.equal(ok, true);
        // ghost 被丢弃，a 排第一；b 因为没出现在列表里被追到末尾
        assert.deepEqual(tm.priorityOrder, ['a.json', 'b.json']);
        assert.equal(tm.getNextCredential({}).user_id, 'u0');
    });
});

test('全部是未知文件名时拒绝设置，保持原状', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.setPriorityOrder(['b.json', 'a.json']);
        assert.equal(tm.setPriorityOrder(['x.json', 'y.json']), false);
        assert.deepEqual(tm.priorityOrder, ['b.json', 'a.json']);
    });
});

test('clearPriorityOrder 回到轮转', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);
        tm.clearPriorityOrder();
        assert.deepEqual(tm.priorityOrder, []);

        const seen = new Set();
        for (let i = 0; i < 3; i++) seen.add(tm.getNextCredential({}).user_id);
        assert.equal(seen.size, 3);
    });
});

test('设置优先级会清掉之前的手动选择，避免队首形同虚设', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setManualCredential(0); // 先手动指定 a
        assert.equal(tm.manualSelectedIndex, 0);

        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);
        // 排了序之后手动指定必须让位，否则用户把 c 拖到第一却还在用 a
        assert.equal(tm.manualSelectedIndex, null);
        assert.equal(tm.getNextCredential({}).user_id, 'u2');
    });
});

test('底层 API 仍支持手动指定，且排在优先级之前（面板已不再暴露这个按钮）', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);
        tm.setManualCredential(0); // 直接调 API 指定 a
        assert.equal(tm.getNextCredential({}).user_id, 'u0');
    });
});

test('新增账号：没排过序时把它排到队首，且不清空其他号的冷却', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        // 先制造一个真实冷却状态（比如 402 余额不足）
        tm.markRateLimited(0, 600000, 'balance');
        assert.equal(tm.isRateLimited(0), true);

        tm.addCredentialWithData({
            bearer_token: 't-new',
            user_id: 'u-new',
            created_at: Math.floor(Date.now() / 1000),
            expires_in: 999999
        });

        // 新号排到第一位
        const newIdx = tm.credentials.findIndex((c) => c.data.user_id === 'u-new');
        const newKey = tm.credentials[newIdx].filePath.split(/[\\/]/).pop();
        assert.equal(tm.priorityOrder[0], newKey);
        assert.equal(tm.getNextCredential({}).user_id, 'u-new');

        // 关键：老账号的 402 冷却不该因为"加了个新号"被抹掉
        assert.equal(tm.isRateLimited(0), true);
    });
});

test('优先级同时写入粘性绑定，同一会话后续仍落在同一个号', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        tm.setPriorityOrder(['b.json', 'a.json']);
        assert.equal(tm.getNextCredential({sessionKey: 's1'}).user_id, 'u1');
        // 队首 b 冷却后，同一会话要换号，换完黏在新号上
        tm.markRateLimited(1, 60_000, 'soft');
        assert.equal(tm.getNextCredential({sessionKey: 's1'}).user_id, 'u0');
        // 再次请求（b 仍在冷却）应命中粘性，稳定在 a
        assert.equal(tm.getNextCredential({sessionKey: 's1'}).user_id, 'u0');
    });
});

test('getCredentialsInfo 暴露 priorityRank', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);
        const info = tm.getCredentialsInfo();
        const byFile = Object.fromEntries(info.map((c) => [c.filename, c.priorityRank]));
        assert.equal(byFile['c.json'], 0);
        assert.equal(byFile['a.json'], 1);
        assert.equal(byFile['b.json'], 2);
    });
});

test('排过优先级后 getCredentialsInfo 按优先级顺序返回（面板直接渲染这个数组）', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['b.json', 'c.json', 'a.json']);
        const order = tm.getCredentialsInfo().map((c) => c.filename);
        // 若这里仍按文件加载序返回，前端 loadCredentials 会把拖好的顺序排回去，
        // 用户看到的就是"拖了但没生效"
        assert.deepEqual(order, ['b.json', 'c.json', 'a.json']);
    });
});

test('排序后 index 仍是原始下标，删除/禁用靠它定位', async () => {
    await withManager(['a.json', 'b.json', 'c.json'], (tm) => {
        tm.setPriorityOrder(['c.json', 'a.json', 'b.json']);
        const info = tm.getCredentialsInfo();
        // 第一条是 c，但它的 index 应该是 2（文件加载序），不是 0
        assert.equal(info[0].filename, 'c.json');
        assert.equal(info[0].index, 2);
        // 用这个 index 禁用，应该禁掉 c 而不是第一条
        tm.toggleCredentialDisable(info[0].index);
        assert.ok(tm.disabledIndexes.includes(2));
        assert.ok(!tm.disabledIndexes.includes(0));
    });
});

test('未设置优先级时 priorityRank 为 -1（前端据此不画序号）', async () => {
    await withManager(['a.json', 'b.json'], (tm) => {
        for (const c of tm.getCredentialsInfo()) {
            assert.equal(c.priorityRank, -1);
        }
    });
});
