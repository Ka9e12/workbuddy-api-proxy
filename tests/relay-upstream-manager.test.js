import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UpstreamManager} from '../src/services/relay/upstream-manager.js';

async function withServer(handler, run) {
    const requests = [];
    const server = createServer((req, res) => {
        requests.push({method: req.method, url: req.url});
        handler(req, res);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();

    try {
        await run(`http://127.0.0.1:${port}`, requests);
    } finally {
        await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
}

async function withManager(run) {
    const dir = await mkdtemp(join(tmpdir(), 'relay-upstream-manager-'));
    try {
        await run(new UpstreamManager(dir));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

test('responses upstream connection test uses the configured v1 base URL without duplicating v1', async () => {
    await withServer((req, res) => {
        res.writeHead(req.url === '/copilot/v1/responses' ? 200 : 404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({id: 'resp_test', output: [], usage: {}}));
    }, async (baseUrl, requests) => {
        await withManager(async (manager) => {
            manager.addUpstream({
                name: 'local copilot responses',
                base_url: `${baseUrl}/copilot/v1`,
                api_key: 'sk-test',
                models: ['gpt-4.1'],
                protocol: 'responses'
            });

            const result = await manager.testUpstream(0);

            assert.equal(result.success, true, result.message);
            assert.deepEqual(requests.map((request) => request.url), ['/copilot/v1/responses']);
        });
    });
});
