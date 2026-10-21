import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';

/**
 * 换号重试依赖两个新能力：
 * - excludeIndexes：本次请求已失败过的号不再选
 * - preferDifferentSite：优先挑与失败号不同上游的号
 *
 * 后者是本项目特有的：6021（集群排队）和 11128（WAF）在同站点内换号没用，
 * 但换到别的站点就可能绕开。
 */

async function withManager(accounts, run) {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-failover-pick-'));
    try {
        await mkdir(join(dir, 'credentials'), {recursive: true});
        const now = Math.floor(Date.now() / 1000);
        for (const acc of accounts) {
            await writeFile(
                join(dir, 'credentials', acc.filename),
                JSON.stringify({
                    bearer_token: `t-${acc.filename}`,
                    user_id: acc.userId || acc.filename,
                    base_url: acc.baseUrl,
                    created_at: now,
                    expires_in: 999999
                })
            );
        }
        if (accounts.priorityOrder) {
            await writeFile(
                join(dir, 'state.json'),
                JSON.stringify({priorityOrder: accounts.priorityOrder})
            );
        }
        await run(new TenantTokenManager(dir));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}


/**
 * 按文件名找索引：凭证按文件名排序加载，测试里硬编码下标很容易错位。
 */
function idxOf(tm, filename) {
    const i = tm.credentials.findIndex((c) => c.filePath.split(/[\\/]/).pop() === filename);
    assert.ok(i >= 0, `${filename} 不在凭证列表里`);
    return i;
}

const CN = 'https://copilot.tencent.com';
const INTL = 'https://www.codebuddy.ai';

test('excludeIndexes 排除掉的号不会被选中', async () => {
    await withManager(
        [
            {filename: 'a.json', baseUrl: CN},
            {filename: 'b.json', baseUrl: CN},
            {filename: 'c.json', baseUrl: CN}
        ],
        (tm) => {
            const picked = tm.getNextCredential({
                excludeIndexes: [idxOf(tm, 'a.json'), idxOf(tm, 'b.json')]
            });
            assert.equal(picked.user_id, 'c.json');
        }
    );
});

test('所有候选都被排除时忽略排除名单，不返回 null', async () => {
    await withManager([{filename: 'a.json', baseUrl: CN}, {filename: 'b.json', baseUrl: CN}], (tm) => {
        const picked = tm.getNextCredential({
            excludeIndexes: [idxOf(tm, 'a.json'), idxOf(tm, 'b.json')]
        });
        assert.ok(picked, '池子里还有可用号时不该返回 null');
    });
});

test('preferDifferentSite：换号时优先跨站点', async () => {
    await withManager(
        [
            {filename: 'intl-1.json', baseUrl: INTL},
            {filename: 'intl-2.json', baseUrl: INTL},
            {filename: 'cn-1.json', baseUrl: CN}
        ],
        (tm) => {
            // 国际站 0 号失败过，池子里还有同站点 1 号和跨站点 cn-1
            const picked = tm.getNextCredential({
                excludeIndexes: [idxOf(tm, 'intl-1.json')],
                preferDifferentSite: true
            });
            assert.equal(picked.user_id, 'cn-1.json', '应优先跨站点，而不是同站点换个号');
        }
    );
});

test('preferDifferentSite：只有同站点可用时才退回同站点', async () => {
    await withManager(
        [
            {filename: 'intl-1.json', baseUrl: INTL},
            {filename: 'intl-2.json', baseUrl: INTL}
        ],
        (tm) => {
            const picked = tm.getNextCredential({
                excludeIndexes: [idxOf(tm, 'intl-1.json')],
                preferDifferentSite: true
            });
            assert.equal(picked.user_id, 'intl-2.json');
        }
    );
});

test('不传 preferDifferentSite 时不影响原有选择', async () => {
    await withManager(
        [
            {filename: 'intl-1.json', baseUrl: INTL},
            {filename: 'cn-1.json', baseUrl: CN}
        ],
        (tm) => {
            // 不传 preferDifferentSite，排除后只剩 cn-1
            const picked = tm.getNextCredential({excludeIndexes: [idxOf(tm, 'intl-1.json')]});
            assert.equal(picked.user_id, 'cn-1.json');
        }
    );
});

test('preferDifferentSite 与作用域白名单叠加生效', async () => {
    await withManager(
        [
            {filename: 'intl-1.json', baseUrl: INTL},
            {filename: 'intl-2.json', baseUrl: INTL},
            {filename: 'cn-1.json', baseUrl: CN}
        ],
        (tm) => {
            // 白名单里只有 intl-1 和 intl-2，跨站点的 cn-1 不可用
            const picked = tm.getNextCredential({
                allowedFilenames: ['intl-1.json', 'intl-2.json'],
                excludeIndexes: [idxOf(tm, 'intl-1.json')],
                preferDifferentSite: true
            });
            assert.equal(picked.user_id, 'intl-2.json');
        }
    );
});

test('单账号池：排除后没有别的号，仍然返回它（重试同一号比不返回好）', async () => {
    await withManager([{filename: 'only.json', baseUrl: INTL}], (tm) => {
        const picked = tm.getNextCredential({
            excludeIndexes: [idxOf(tm, 'only.json')],
            preferDifferentSite: true
        });
        assert.equal(picked.user_id, 'only.json');
    });
});

test('unbindSession 带作用域时能解绑对应键', async () => {
    await withManager([{filename: 'a.json', baseUrl: CN}, {filename: 'b.json', baseUrl: CN}], (tm) => {
        tm.getNextCredential({sessionKey: 's1', affinityScope: 'keyA'});
        assert.equal(tm.sessionAffinity.size, 1);

        tm.unbindSession('s1', 'keyA');
        assert.equal(tm.sessionAffinity.size, 0, '带作用域解绑必须命中');
    });
});

test('unbindSession 不带作用域时清掉该会话在所有作用域下的绑定', async () => {
    await withManager([{filename: 'a.json', baseUrl: CN}, {filename: 'b.json', baseUrl: CN}], (tm) => {
        tm.getNextCredential({sessionKey: 's1', affinityScope: 'keyA'});
        tm.getNextCredential({sessionKey: 's1', affinityScope: 'keyB'});
        assert.equal(tm.sessionAffinity.size, 2);

        tm.unbindSession('s1');
        assert.equal(tm.sessionAffinity.size, 0, '漏传作用域时也要兜底清干净');
    });
});

test('unbindSession 只解绑目标会话，不误伤别的会话', async () => {
    await withManager([{filename: 'a.json', baseUrl: CN}, {filename: 'b.json', baseUrl: CN}], (tm) => {
        tm.getNextCredential({sessionKey: 's1', affinityScope: 'keyA'});
        tm.getNextCredential({sessionKey: 's2', affinityScope: 'keyA'});
        tm.unbindSession('s1', 'keyA');
        assert.equal(tm.sessionAffinity.size, 1);
        assert.ok(tm.sessionAffinity.has('keyA:s2'));
    });
});
