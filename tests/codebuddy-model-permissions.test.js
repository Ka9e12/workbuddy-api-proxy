import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelPermissionStore, classifyModelPermission, isUnavailableKind} from '../src/services/codebuddy/model-permissions.js';

/**
 * 模型权限缓存
 *
 * 上游 `/v3/config` 只给「客户端能看见的模型」，不给「账号能不能调」。
 * 免费账号能看见 gpt-5.5，一调就 11158。不记住这个事实，客户端就会一直选到它。
 */

function apiError(code, message = '') {
    return Object.assign(new Error(message || `code ${code}`), {code, status: 400});
}

async function withStore(run) {
    const dir = await mkdtemp(join(tmpdir(), 'model-perm-'));
    try {
        await run(new ModelPermissionStore(dir), dir);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

test('11158（账号类型不支持）判为权限受限', () => {
    const v = classifyModelPermission(apiError(11158, 'model [gpt-5.5] is not allowed for user type [personal_free_user]'));
    assert.equal(v.kind, 'forbidden');
    assert.equal(isUnavailableKind(v.kind), true);
    assert.match(v.reason, /账号不支持/);
});

test('11102 有两种含义：权限不足 vs 模型不存在', () => {
    // 实测 gemini-3.5-flash → "only available for authorized users"
    const forbidden = classifyModelPermission(apiError(11102, 'model [gemini-3.5-flash] is only available for authorized users'));
    assert.equal(forbidden.kind, 'forbidden', '这是权限问题，不是额度');

    // 实测 glm-4.7 / hy4-preview-x → "service info not found"
    const missing = classifyModelPermission(apiError(11102, 'model [glm-4.7] service info not found'));
    assert.equal(missing.kind, 'missing', '模型不存在是另一回事，不能算到账号头上');
});

test('11133（模型拒绝请求）归为模型不存在', () => {
    const v = classifyModelPermission(apiError(11133));
    assert.equal(v.kind, 'missing');
    assert.equal(isUnavailableKind(v.kind), true);
});

test('6004（今日额度用完）不算不可用，且带出重置时刻', () => {
    // 实测 deepseek-v4.1-flash：'您的使用量已超出频率限制，将在 2026-10-22 20:05:02 UTC+8 重置'
    const v = classifyModelPermission(
        apiError(6004, '您的使用量已超出频率限制，将在 2026-10-22 20:05:02 UTC+8 重置，')
    );
    assert.equal(v.kind, 'quota');
    assert.equal(isUnavailableKind(v.kind), false, '额度用完只是当天用超了，不该标成不可用');
    assert.match(v.reason, /2026-10-22/, '应把上游给的重置时刻透出来');
});

test('6004 没有重置时刻时也给个合理提示', () => {
    const v = classifyModelPermission(apiError(6004));
    assert.equal(v.kind, 'quota');
    assert.match(v.reason, /稍后会自动恢复/);
});

test('其它错误不算模型状态问题', () => {
    for (const code of [429, 402, 404, 6021, 11128, null, undefined]) {
        assert.equal(classifyModelPermission(apiError(code)).kind, null, `${code} 不该记录模型状态`);
    }
    assert.equal(classifyModelPermission(null).kind, null);
});

test('记录后能查到，未记录的不受影响', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'gpt-5.5', error: apiError(11158)});
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, true);
        assert.equal(store.isBlocked('a.json', 'glm-5.3').blocked, false, '没记录的模型不该被牵连');
        assert.equal(store.isBlocked('b.json', 'gpt-5.5').blocked, false, '别的账号不受影响');
    });
});

test('权限是按账号记的，不是全局的', async () => {
    // 同一台机器上，免费号和付费号能用的模型不一样，不能混在一起
    await withStore((store) => {
        store.recordBlocked({account: 'free.json', model: 'gpt-5.5', error: apiError(11158)});
        assert.equal(store.isBlocked('free.json', 'gpt-5.5').blocked, true);
        assert.equal(store.isBlocked('paid.json', 'gpt-5.5').blocked, false);
    });
});

test('记录可用后清掉之前的不可用标记', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'gpt-5.5', error: apiError(11158)});
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, true);

        // 用户升级了套餐，重测通了
        store.recordAvailable('a.json', 'gpt-5.5');
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, false);
    });
});

test('额度类限制会过期，权限类不会（短期内）', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'quota-model', error: apiError(6004)});
        store.recordBlocked({account: 'a.json', model: 'no-perm', error: apiError(11158)});

        // 手工把两条记录都改成已过期，验证过期即视为恢复
        const map = store.accounts.get('a.json');
        map.get('quota-model').expiresAt = Date.now() - 1000;
        map.get('no-perm').expiresAt = Date.now() + 100000;

        assert.equal(store.isBlocked('a.json', 'quota-model').blocked, false, '额度限制过期后应恢复');
        assert.equal(store.isBlocked('a.json', 'no-perm').blocked, true, '权限限制不该提前过期');
    });
});

test('落盘后新实例能读到（重启不丢）', async () => {
    await withStore(async (store, dir) => {
        store.recordBlocked({account: 'a.json', model: 'gpt-5.5', error: apiError(11158), email: 'x@y.com'});

        const raw = JSON.parse(await readFile(join(dir, 'model-permissions.json'), 'utf8'));
        assert.equal(raw.version, 1);
        assert.ok(raw.accounts['a.json']['gpt-5.5']);

        const fresh = new ModelPermissionStore(dir);
        assert.equal(fresh.isBlocked('a.json', 'gpt-5.5').blocked, true);
        assert.match(fresh.isBlocked('a.json', 'gpt-5.5').reason, /账号不支持/);
    });
});

test('blockedFor 返回该账号全部不可用模型', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'gpt-5.5', error: apiError(11158)});
        store.recordBlocked({account: 'a.json', model: 'gemini-3.5-flash', error: apiError(11158)});
        store.recordBlocked({account: 'b.json', model: 'glm-5.3', error: apiError(6004)});

        const a = store.blockedFor('a.json');
        assert.equal(a.size, 2);
        assert.ok(a.has('gpt-5.5'));
        assert.ok(a.has('gemini-3.5-flash'));
        assert.equal(store.blockedFor('b.json').size, 1);
        assert.equal(store.blockedFor('c.json').size, 0);
    });
});

test('clearAccount 只清目标账号', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'x', error: apiError(11158)});
        store.recordBlocked({account: 'b.json', model: 'x', error: apiError(11158)});
        store.clearAccount('a.json');
        assert.equal(store.isBlocked('a.json', 'x').blocked, false);
        assert.equal(store.isBlocked('b.json', 'x').blocked, true);
    });
});

test('损坏的缓存文件不炸，按空处理', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-perm-bad-'));
    try {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(join(dir, 'model-permissions.json'), '{ not json');
        const store = new ModelPermissionStore(dir);
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, false);
        // 还能正常写
        store.recordBlocked({account: 'a.json', model: 'gpt-5.5', error: apiError(11158)});
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, true);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('非权限类错误不写入缓存', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'm', error: apiError(429)});
        assert.equal(store.isBlocked('a.json', 'm').blocked, false, '限流不该被当成没权限');
    });
});

test('真实请求成功后清掉记录（升级套餐 / 额度恢复的路径）', async () => {
    // 用户最关心的一点：手动测通了、或真实调用成功了，列表里的「不可用」要自己消失，
    // 不能让人去删文件。
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'gpt-5.5', error: apiError(11158)});
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, true);

        // 模拟一次成功调用
        store.recordAvailable('a.json', 'gpt-5.5');
        assert.equal(store.isBlocked('a.json', 'gpt-5.5').blocked, false);
        assert.equal(store.blockedFor('a.json').size, 0, 'blockedFor 里也该消失');
    });
});

test('清除记录后落盘，重启也不会复活', async () => {
    await withStore(async (store, dir) => {
        store.recordBlocked({account: 'a.json', model: 'x', error: apiError(11158)});
        store.recordAvailable('a.json', 'x');

        const fresh = new ModelPermissionStore(dir);
        assert.equal(fresh.isBlocked('a.json', 'x').blocked, false);
    });
});

test('别的进程刚写过磁盘时，本进程的清除仍然生效', async () => {
    // 曾经踩过的坑：内存快照是启动时读的，另一个进程（面板、真实请求）往同一个文件里
    // 记了新内容之后，本进程直接把旧快照写回去，会把别人刚写的整份覆盖掉。
    // recordAvailable 现在每次都 reload，这条测试守住它。
    await withStore(async (store, dir) => {
        store.recordBlocked({account: 'a.json', model: 'old', error: apiError(11158)});
        store.load(); // 建立内存快照

        // 模拟另一个进程写入：绕过 store，直接改文件
        const file = join(dir, 'model-permissions.json');
        const raw = JSON.parse(await readFile(file, 'utf8'));
        raw.accounts['a.json']['fresh'] = {
            kind: 'forbidden',
            code: 11158,
            reason: '别的进程写的',
            at: Date.now(),
            expiresAt: Date.now() + 86400000
        };
        await writeFile(file, JSON.stringify(raw, null, 2), 'utf8');

        store.recordAvailable('a.json', 'old');

        const after = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(after.accounts['a.json']['old'], undefined, '目标记录要清掉');
        assert.ok(after.accounts['a.json']['fresh'], '别人刚写的记录不能被覆盖掉');
    });
});

test('额度记录 30 分钟后自动失效，权限记录保持', async () => {
    await withStore((store) => {
        store.recordBlocked({account: 'a.json', model: 'q', error: apiError(6004)});
        store.recordBlocked({account: 'a.json', model: 'f', error: apiError(11158)});

        const map = store.accounts.get('a.json');
        const qTtl = map.get('q').expiresAt - Date.now();
        const fTtl = map.get('f').expiresAt - Date.now();
        assert.ok(qTtl <= 30 * 60 * 1000 + 1000, `额度 TTL 应在 30 分钟内，实际 ${qTtl}`);
        assert.ok(fTtl > 6 * 24 * 60 * 60 * 1000, `权限 TTL 应接近 7 天，实际 ${fTtl}`);
    });
});
