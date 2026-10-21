import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, rm, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * 路由层的端到端作用域验证：API Key 能看见哪些模型。
 *
 * 用两个本地 mock 上游冒充「国内站 / 国际站」，各自的 /v3/config 返回不同模型。
 * 断言的是「Key 的 allowedCredentialFiles 真的收窄了 /v1/models」——
 * 这是用户需求里最容易被绕过的一环（若按 realm 分组而不是 baseUrl，就会串站）。
 *
 * 注意：credentialStore 是模块级单例，凭证目录在构造时由 CODEBUDDY_CREDS_DIR 决定，
 * 因此这里只能在 import 之前设好一个固定目录，各用例复用它并自行清空重写。
 */

const CREDS_DIR = '.tmp-key-scope-creds';

/** 起一个只认 /v3/config 的假上游 */
async function startMockUpstream(models) {
    const server = createServer((req, res) => {
        if (req.url.startsWith('/v3/config')) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({data: {models}}));
            return;
        }
        res.writeHead(404);
        res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    return {server, baseUrl: `http://127.0.0.1:${port}`};
}

// 必须在 import 路由模块之前设置：config.js 在模块求值时读取
process.env.CODEBUDDY_CREDS_DIR = CREDS_DIR;
await mkdir(join(CREDS_DIR, 'credentials'), {recursive: true});
const {routeCodebuddyRequest} = await import('../src/routes/codebuddy.js');
const {credentialStore} = await import('../src/services/codebuddy/credential-store.js');

/**
 * 重写凭证目录，并让单例重新读取
 * @param {Array<{filename: string, userId: string, baseUrl: string}>} accounts
 */
async function setAccounts(accounts) {
    const credDir = join(CREDS_DIR, 'credentials');
    for (const file of await readdir(credDir)) {
        await rm(join(credDir, file), {force: true});
    }
    const now = Math.floor(Date.now() / 1000);
    for (const [i, acc] of accounts.entries()) {
        await writeFile(
            join(credDir, acc.filename),
            JSON.stringify({
                bearer_token: `fake-token-${i}`,
                user_id: acc.userId,
                base_url: acc.baseUrl,
                created_at: now,
                expires_in: 999999
            })
        );
    }
    const tm = credentialStore.getTokenManager();
    tm.credentials = [];
    tm.disabledIndexes = [];
    tm.loadAllTokens();
    return tm;
}

/**
 * 直接调路由处理函数（跳过 HTTP 与网关鉴权，手工挂上 req._gatewayKey）
 * @param {string} url
 * @param {null|string[]|undefined} allowedCredentialFiles - undefined 表示「没经过网关，视为不限」
 */
function callModels(url, allowedCredentialFiles) {
    return new Promise((resolve) => {
        let statusCode = 200;
        const req = {
            method: 'GET',
            url,
            headers: {host: '127.0.0.1'},
            socket: {remoteAddress: '127.0.0.1'}
        };
        if (allowedCredentialFiles !== undefined) {
            req._gatewayKey = {id: 'k_test', label: 't', allowedCredentialFiles};
        }
        const res = {
            writeHead(status) {
                statusCode = status;
            },
            end(data = '') {
                let parsed = null;
                try {
                    parsed = data ? JSON.parse(data) : null;
                } catch {
                    parsed = {raw: data};
                }
                resolve({statusCode, body: parsed});
            }
        };
        Promise.resolve(routeCodebuddyRequest(req, res)).catch((err) => {
            resolve({statusCode: 500, body: {error: {message: err.message}}});
        });
    });
}

test.after(async () => {
    await rm(CREDS_DIR, {recursive: true, force: true});
});

test('只勾国内站账号：/v1/models 不返回国际站模型', async () => {
    const cn = await startMockUpstream([
        {id: 'glm-5.3', name: 'GLM 国内'},
        {id: 'kimi-k3-1', name: 'Kimi 国内'}
    ]);
    const intl = await startMockUpstream([
        {id: 'gpt-5.5', name: 'GPT'},
        {id: 'default-model', name: 'Auto'}
    ]);
    try {
        await setAccounts([
            {filename: 'cn-account.json', userId: 'u-cn', baseUrl: cn.baseUrl},
            {filename: 'intl-account.json', userId: 'u-intl', baseUrl: intl.baseUrl}
        ]);

        const scoped = await callModels('/codebuddy/v1/models', ['cn-account.json']);
        assert.equal(scoped.statusCode, 200);
        assert.deepEqual(
            scoped.body.data.map((m) => m.id).sort(),
            ['glm-5.3', 'kimi-k3-1']
        );

        // 对照：不限作用域时两边都在
        const all = await callModels('/codebuddy/v1/models', null);
        assert.equal(all.statusCode, 200);
        const allIds = all.body.data.map((m) => m.id);
        assert.ok(allIds.includes('gpt-5.5'));
        assert.ok(allIds.includes('glm-5.3'));
    } finally {
        cn.server.close();
        intl.server.close();
    }
});

test('两个站都勾：同名模型只出现一次', async () => {
    const cn = await startMockUpstream([
        {id: 'glm-5.3', name: 'GLM 国内'},
        {id: 'shared', name: '共享'}
    ]);
    const intl = await startMockUpstream([
        {id: 'shared', name: '共享（国际）'},
        {id: 'gpt-5.5', name: 'GPT'}
    ]);
    try {
        await setAccounts([
            {filename: 'a.json', userId: 'u1', baseUrl: cn.baseUrl},
            {filename: 'b.json', userId: 'u2', baseUrl: intl.baseUrl}
        ]);
        const result = await callModels('/codebuddy/v1/models', ['a.json', 'b.json']);
        assert.equal(result.statusCode, 200);
        const ids = result.body.data.map((m) => m.id);
        assert.equal(ids.filter((id) => id === 'shared').length, 1);
        assert.ok(ids.includes('gpt-5.5'));
    } finally {
        cn.server.close();
        intl.server.close();
    }
});

test('作用域全空 / 全失效：503，不回落到其它账号', async () => {
    const cn = await startMockUpstream([{id: 'glm-5.3', name: 'GLM'}]);
    try {
        await setAccounts([{filename: 'a.json', userId: 'u1', baseUrl: cn.baseUrl}]);

        const empty = await callModels('/codebuddy/v1/models', []);
        assert.equal(empty.statusCode, 503);

        const ghost = await callModels('/codebuddy/v1/models', ['gone.json']);
        assert.equal(ghost.statusCode, 503);

        const anthropic = await callModels('/codebuddy/anthropic/v1/models', ['gone.json']);
        assert.equal(anthropic.statusCode, 503);
        assert.equal(anthropic.body.type, 'error');
    } finally {
        cn.server.close();
    }
});

test('Anthropic 侧同样按作用域收窄', async () => {
    const cn = await startMockUpstream([{id: 'glm-5.3', name: 'GLM'}]);
    const intl = await startMockUpstream([{id: 'gpt-5.5', name: 'GPT'}]);
    try {
        await setAccounts([
            {filename: 'a.json', userId: 'u1', baseUrl: cn.baseUrl},
            {filename: 'b.json', userId: 'u2', baseUrl: intl.baseUrl}
        ]);
        const result = await callModels('/codebuddy/anthropic/v1/models', ['b.json']);
        assert.equal(result.statusCode, 200);
        assert.deepEqual(
            result.body.data.map((m) => m.id),
            ['gpt-5.5']
        );
    } finally {
        cn.server.close();
        intl.server.close();
    }
});

test('作用域内的账号被禁用后，模型列表变 503', async () => {
    const cn = await startMockUpstream([{id: 'glm-5.3', name: 'GLM'}]);
    try {
        const tm = await setAccounts([{filename: 'a.json', userId: 'u1', baseUrl: cn.baseUrl}]);

        const before = await callModels('/codebuddy/v1/models', ['a.json']);
        assert.equal(before.statusCode, 200);

        tm.toggleCredentialDisable(0);
        const after = await callModels('/codebuddy/v1/models', ['a.json']);
        assert.equal(after.statusCode, 503, '唯一允许的号被禁用后不应回落到别的号');
    } finally {
        cn.server.close();
    }
});
