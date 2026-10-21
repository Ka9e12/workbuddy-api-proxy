import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, rm, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * 端到端验证「同请求内换号」：
 * 起一个慢上游（模拟国际站卡住不回话），一个快上游（模拟国内站正常），
 * 断言一次请求之内就完成了换号，且客户端最终拿到 200。
 *
 * 环境变量必须在 import 路由模块之前设置（超时与凭证目录都在模块求值时读取）。
 */

const CREDS_DIR = '.tmp-failover-creds';

// 首字节超时压到 1.5 秒、流空闲 3 秒，让测试跑得快但边界仍真实
process.env.CODEBUDDY_CREDS_DIR = CREDS_DIR;
process.env.CODEBUDDY_CONNECT_TIMEOUT_MS = '1500';
process.env.CODEBUDDY_IDLE_TIMEOUT_MS = '3000';
process.env.CODEBUDDY_FAILOVER_ATTEMPTS = '2';

await mkdir(join(CREDS_DIR, 'credentials'), {recursive: true});
const {routeCodebuddyRequest} = await import('../src/routes/codebuddy.js');
const {credentialStore} = await import('../src/services/codebuddy/credential-store.js');

/** 慢上游：接受连接但永不回响应头，模拟"上游卡住" */
async function startSilentUpstream() {
    const server = createServer(() => {
        // 故意不响应，让客户端等到首字节超时
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {server, baseUrl: `http://127.0.0.1:${server.address().port}`};
}

/** 正常上游：返回一条最小的 SSE 流 */
async function startHealthyUpstream({model = 'glm-5.3'} = {}) {
    const server = createServer((req, res) => {
        if (req.url.startsWith('/v3/config')) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({data: {models: [{id: model, name: model}]}}));
            return;
        }
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        res.write(
            `data: ${JSON.stringify({
                id: 'chatcmpl-test',
                model,
                choices: [{index: 0, delta: {content: 'hello'}, finish_reason: null}]
            })}\n\n`
        );
        res.write(
            `data: ${JSON.stringify({
                id: 'chatcmpl-test',
                model,
                choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
                usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}
            })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {server, baseUrl: `http://127.0.0.1:${server.address().port}`};
}

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
                bearer_token: `fake-${i}`,
                user_id: acc.filename,
                base_url: acc.baseUrl,
                created_at: now,
                expires_in: 999999
            })
        );
    }
    const tm = credentialStore.getTokenManager();
    tm.credentials = [];
    tm.disabledIndexes = [];
    tm.sessionAffinity.clear();
    tm.rateLimitedIndexes.clear();
    tm.priorityOrder = [];
    tm.loadAllTokens();
    return tm;
}

/** 直接调路由处理函数，模拟网关鉴权已完成 */
function post(url, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        let statusCode = 200;
        let data = '';
        const req = {
            method: 'POST',
            url,
            headers: {
                host: '127.0.0.1',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            },
            socket: {remoteAddress: '127.0.0.1'},
            [Symbol.asyncIterator]: async function* () {
                yield Buffer.from(payload);
            }
        };
        const res = {
            writeHead(status) {
                statusCode = status;
            },
            write(chunk) {
                data += chunk;
                return true;
            },
            end(chunk = '') {
                data += chunk;
                resolve({statusCode, body: data});
            },
            destroyed: false
        };
        Promise.resolve(routeCodebuddyRequest(req, res)).catch((err) => {
            resolve({statusCode: 500, body: String(err.message)});
        });
    });
}

test.after(async () => {
    await rm(CREDS_DIR, {recursive: true, force: true});
});

test('国际站卡住不回话时，同一请求内换到国内站并成功', async () => {
    const silent = await startSilentUpstream();
    const healthy = await startHealthyUpstream();
    try {
        const tm = await setAccounts([
            {filename: 'intl-account.json', baseUrl: silent.baseUrl},
            {filename: 'cn-account.json', baseUrl: healthy.baseUrl}
        ]);
        // 固定让国际站先接单，否则可能首轮就命中国内站，测不到换号
        tm.setPriorityOrder(['intl-account.json', 'cn-account.json']);

        const started = Date.now();
        const result = await post('/codebuddy/v1/chat/completions', {
            model: 'glm-5.3',
            stream: false,
            messages: [{role: 'user', content: 'hi'}]
        });
        const elapsed = Date.now() - started;

        assert.equal(result.statusCode, 200, `应换号成功，实际响应：${result.body.slice(0, 200)}`);
        assert.match(result.body, /hello/);
        // 只等了一次首字节超时（1.5s），没有等满 http-client 的 120s 默认值
        assert.ok(elapsed < 6000, `换号应发生在一次超时之内，实际用了 ${elapsed}ms`);
        assert.ok(elapsed >= 1400, `应当先等满一次首字节超时，实际只有 ${elapsed}ms（说明没走国际站）`);
    } finally {
        silent.server.close();
        healthy.server.close();
    }
});

test('池子里只有一个号时不重试，直接返回错误', async () => {
    const silent = await startSilentUpstream();
    try {
        await setAccounts([{filename: 'only-intl.json', baseUrl: silent.baseUrl}]);

        const started = Date.now();
        const result = await post('/codebuddy/v1/chat/completions', {
            model: 'glm-5.3',
            stream: false,
            messages: [{role: 'user', content: 'hi'}]
        });
        const elapsed = Date.now() - started;

        assert.equal(result.statusCode, 502, '上游超时应报 502');
        // 单号池不重试：只等一次超时
        assert.ok(elapsed < 4000, `不该叠加两次超时，实际 ${elapsed}ms`);
    } finally {
        silent.server.close();
    }
});

test('作用域只剩一个号时不做跨号重试', async () => {
    const silent = await startSilentUpstream();
    const healthy = await startHealthyUpstream();
    try {
        await setAccounts([
            {filename: 'intl-account.json', baseUrl: silent.baseUrl},
            {filename: 'cn-account.json', baseUrl: healthy.baseUrl}
        ]);

        // 这个 Key 只允许国际站账号，池子里虽然还有国内站但越权不可用
        const started = Date.now();
        const result = await new Promise((resolve) => {
            const payload = JSON.stringify({
                model: 'glm-5.3',
                stream: false,
                messages: [{role: 'user', content: 'hi'}]
            });
            let statusCode = 200;
            let data = '';
            const req = {
                method: 'POST',
                url: '/codebuddy/v1/chat/completions',
                headers: {
                    host: '127.0.0.1',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload)
                },
                socket: {remoteAddress: '127.0.0.1'},
                _gatewayKey: {id: 'k1', label: 't', allowedCredentialFiles: ['intl-account.json']},
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(payload);
                }
            };
            const res = {
                writeHead(status) {
                    statusCode = status;
                },
                write(chunk) {
                    data += chunk;
                    return true;
                },
                end(chunk = '') {
                    data += chunk;
                    resolve({statusCode, body: data});
                },
                destroyed: false
            };
            Promise.resolve(routeCodebuddyRequest(req, res)).catch((err) => {
                resolve({statusCode: 500, body: String(err.message)});
            });
        });
        const elapsed = Date.now() - started;

        assert.equal(result.statusCode, 502);
        assert.ok(elapsed < 4000, `作用域内只有一个号，不该重试，实际 ${elapsed}ms`);
    } finally {
        silent.server.close();
        healthy.server.close();
    }
});
