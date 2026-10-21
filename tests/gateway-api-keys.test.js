import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiKeyStore, normalizeScope, maskToken, hashToken} from '../src/services/gateway/api-key-store.js';

/**
 * 多 Key 存储的核心约定：
 * - 旧单令牌文件迁移成一条「不限账号」的 Key，且幂等
 * - `null`（不限）与 `[]`（全禁）绝不可互相归一化
 * - 白名单只认文件名 basename
 * - 至少保留一条 Key
 */

async function withStore(run, seed) {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-keys-'));
    try {
        if (seed) await seed(dir);
        await run(new ApiKeyStore(dir), dir);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

test('空目录：首次 init 生成一条 Key 并落盘', async () => {
    await withStore(async (store, dir) => {
        store.init();
        const list = store.list();
        assert.equal(list.length, 1);
        assert.equal(list[0].allowed_credential_files, null);
        assert.ok(list[0].token_plain.startsWith('sk-'));

        const raw = JSON.parse(await readFile(join(dir, 'api_keys.json'), 'utf8'));
        assert.equal(raw.version, 1);
        assert.equal(raw.keys.length, 1);
    });
});

test('旧 gateway_token.json 迁移成一条不限作用域的 Key，且幂等', async () => {
    const legacyToken = 'sk-legacy0000000000000000000000000';
    await withStore(
        async (store, dir) => {
            store.init();
            const first = store.list();
            assert.equal(first.length, 1, '不能因为重复 init 造出第二条');
            assert.equal(first[0].token_plain, legacyToken);
            assert.equal(first[0].allowed_credential_files, null);

            // 同一 id：迁移来的 Key 由 token_hash 派生，重启后不变
            const another = new ApiKeyStore(dir);
            another.init();
            assert.equal(another.list()[0].id, first[0].id);
            assert.equal(another.list().length, 1);
        },
        async (dir) => {
            await writeFile(
                join(dir, 'gateway_token.json'),
                JSON.stringify({
                    token_hash: hashToken(legacyToken),
                    token_prefix: maskToken(legacyToken),
                    token_plain: legacyToken,
                    created_at: '2026-01-01T00:00:00.000Z'
                })
            );
        }
    );
});

test('已有 api_keys.json 时永不回读旧文件', async () => {
    await withStore(
        async (store) => {
            store.init();
            const list = store.list();
            assert.equal(list.length, 1);
            assert.notEqual(list[0].token_plain, 'sk-legacy0000000000000000000000000');
        },
        async (dir) => {
            await writeFile(
                join(dir, 'gateway_token.json'),
                JSON.stringify({token_hash: hashToken('sk-legacy0000000000000000000000000')})
            );
            await writeFile(
                join(dir, 'api_keys.json'),
                JSON.stringify({
                    version: 1,
                    keys: [
                        {
                            id: 'k_existing',
                            label: '现有',
                            token_hash: hashToken('sk-real000000000000000000000000000'),
                            token_prefix: maskToken('sk-real000000000000000000000000000'),
                            token_plain: 'sk-real000000000000000000000000000',
                            allowed_credential_files: ['a.json']
                        }
                    ]
                })
            );
        }
    );
});

test('多 Key 各自明文都能解析，错 token 返回 null', async () => {
    await withStore(async (store) => {
        store.init();
        const second = store.create({label: '第二个'});

        const first = store.list()[0];
        assert.equal(store.resolve(first.token_plain)?.id, first.id);
        assert.equal(store.resolve(second.plain)?.id, second.id);

        assert.equal(store.resolve('sk-wrong'), null);
        assert.equal(store.resolve(''), null);
        assert.equal(store.resolve(undefined), null);
        assert.equal(store.resolve(null), null);
        assert.equal(store.resolve({}), null);
    });
});

test('resolve 返回的三态作用域与磁盘一致', async () => {
    await withStore(async (store) => {
        store.init();
        const created = store.create({label: '受限', allowedCredentialFiles: ['b.json', 'a.json']});
        const resolved = store.resolve(created.plain);
        assert.deepEqual(resolved.allowedCredentialFiles, ['a.json', 'b.json']);

        const other = store.create({label: '不限'});
        assert.equal(store.resolve(other.plain).allowedCredentialFiles, null);
    });
});

test('作用域清洗：去重、只留 basename、拒绝路径', () => {
    assert.deepEqual(normalizeScope(['b.json', 'a.json', 'a.json']), ['a.json', 'b.json']);
    assert.deepEqual(normalizeScope(['../secret.json']), []);
    assert.deepEqual(normalizeScope(['dir/a.json']), []);
    assert.equal(normalizeScope(null), null);
    assert.equal(normalizeScope(undefined), null);
    assert.deepEqual(normalizeScope([]), []);
    assert.deepEqual(normalizeScope(['', '  ']), []);
});

test('null 与空数组保持区分', async () => {
    await withStore(async (store) => {
        store.init();
        const unrestricted = store.create({label: '不限', allowedCredentialFiles: null});
        const none = store.create({label: '全禁', allowedCredentialFiles: []});

        assert.equal(store.getById(unrestricted.id).allowed_credential_files, null);
        assert.deepEqual(store.getById(none.id).allowed_credential_files, []);
    });
});

test('拒绝删除最后一条 Key', async () => {
    await withStore(async (store) => {
        store.init();
        const only = store.list()[0];
        const result = store.remove(only.id);
        assert.equal(result.ok, false);
        assert.equal(store.list().length, 1);
    });
});

test('删除中间一条不影响其余 Key 的 id 与明文', async () => {
    await withStore(async (store) => {
        store.init();
        const a = store.list()[0];
        const b = store.create({label: 'B'});
        const c = store.create({label: 'C'});

        assert.equal(store.remove(b.id).ok, true);
        const remaining = store.list();
        assert.deepEqual(
            remaining.map((k) => k.id),
            [a.id, c.id]
        );
        assert.equal(store.resolve(c.plain)?.id, c.id);
        assert.equal(store.resolve(b.plain), null);
    });
});

test('reset 只废目标 Key，其余仍有效', async () => {
    await withStore(async (store) => {
        store.init();
        const first = store.list()[0];
        const second = store.create({label: '第二个'});
        const oldSecondToken = second.plain;

        const updated = store.regenerate(second.id);
        assert.notEqual(updated.plain, oldSecondToken);

        assert.equal(store.resolve(oldSecondToken), null, '旧明文必须失效');
        assert.equal(store.resolve(updated.plain)?.id, second.id);
        assert.equal(store.resolve(first.token_plain)?.id, first.id, '其它 Key 不受影响');
    });
});

test('update 只改声明的字段：省略 allowedCredentialFiles 不会放开限制', async () => {
    await withStore(async (store) => {
        store.init();
        const limited = store.create({label: '受限', allowedCredentialFiles: ['a.json']});

        store.update(limited.id, {label: '改了名字'});
        const after = store.getById(limited.id);
        assert.equal(after.label, '改了名字');
        assert.deepEqual(after.allowed_credential_files, ['a.json'], '改名不能顺手放开权限');

        store.update(limited.id, {allowedCredentialFiles: null});
        assert.equal(store.getById(limited.id).allowed_credential_files, null);
    });
});

test('update 不存在的 id 返回 null，不抛错', async () => {
    await withStore(async (store) => {
        store.init();
        assert.equal(store.update('k_missing', {label: 'x'}), null);
        assert.equal(store.regenerate('k_missing'), null);
    });
});

test('reload 能读到其它进程写入的新 Key', async () => {
    await withStore(async (store, dir) => {
        store.init();
        // 模拟另一个 worker 直接写盘
        const onDisk = JSON.parse(await readFile(join(dir, 'api_keys.json'), 'utf8'));
        onDisk.keys.push({
            id: 'k_other',
            label: '别的 worker 加的',
            token_hash: hashToken('sk-other00000000000000000000000000'),
            token_prefix: maskToken('sk-other00000000000000000000000000'),
            token_plain: 'sk-other00000000000000000000000000',
            allowed_credential_files: null
        });
        await writeFile(join(dir, 'api_keys.json'), JSON.stringify(onDisk));

        store.reload();
        assert.equal(store.list().length, 2);
        assert.equal(store.resolve('sk-other00000000000000000000000000')?.id, 'k_other');
    });
});

test('原子写不留 .tmp 残留', async () => {
    await withStore(async (store, dir) => {
        store.init();
        store.create({label: 'x'});
        const files = await readdir(dir);
        assert.deepEqual(
            files.filter((f) => f.includes('.tmp')),
            []
        );
    });
});

test('损坏的 api_keys.json 不炸，回落到旧文件/新建', async () => {
    await withStore(
        async (store) => {
            store.init();
            assert.equal(store.list().length, 1);
        },
        async (dir) => {
            await writeFile(join(dir, 'api_keys.json'), '{ this is not json');
        }
    );
});

test('maskToken 保持 sk- 前缀与长度约定', () => {
    const masked = maskToken('sk-0123456789abcdef0123456789abcdef');
    assert.ok(masked.startsWith('sk-'));
    assert.ok(masked.includes('****'));
    assert.equal(maskToken(''), 'sk-****');
});
