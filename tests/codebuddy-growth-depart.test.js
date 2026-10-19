import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * 回归：buddy/travel/depart 必须带 location_id。
 *
 * 实测上游对空 body `{}` 返回 HTTP 400 "invalid request"——这正是线上日志里
 * "派猫失败（不影响聊天）：... buddy/travel/depart 返回 HTTP 400" 的根因。
 * 目的地清单在 buddy/travel/config，各地点收益区间相同，取第一个即可。
 */

// GROWTH_BASE 在模块加载时读取，因此必须在 import growth.js 之前设置。
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        const send = (obj) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(obj));
        };
        if (url.pathname.endsWith('/buddy/info')) {
            return send({code: 0, data: {buddy: {name: '暴富喵'}}});
        }
        if (url.pathname.endsWith('/buddy/travel/status')) {
            return send({code: 0, data: {state: 'idle', daily_limit_reached: false}});
        }
        if (url.pathname.endsWith('/buddy/travel/config')) {
            if (configFails) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({code: 500, msg: 'boom'}));
            }
            return send({code: 0, data: {locations: [{id: 3, name: '商场店铺'}, {id: 1, name: '咖啡馆'}]}});
        }
        if (url.pathname.endsWith('/buddy/travel/depart')) {
            departBodies.push(body);
            if (!body || body.location_id === undefined) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({code: 400, msg: 'invalid request'}));
            }
            return send({code: 0, data: {location: {name: '商场店铺'}, duration_hours: 2}});
        }
        send({code: 0, data: {}});
    });
});

const departBodies = [];
let configFails = false;

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.CODEBUDDY_GROWTH_BASE = `http://127.0.0.1:${server.address().port}/activity/growth/`;

const {pickLocationId, departBuddy} = await import('../src/services/codebuddy/growth.js');

test('pickLocationId：取清单第一个 id；空清单返回 null', () => {
    assert.equal(pickLocationId([{id: 3}, {id: 1}]), 3);
    assert.equal(pickLocationId([]), null);
    assert.equal(pickLocationId(null), null);
    assert.equal(pickLocationId([{name: 'no-id'}]), null);
});

test('departBuddy：请求体带 location_id，且从 config 取首个目的地', async () => {
    const cred = {
        bearer_token: 'test-token',
        user_id: 'tester',
        domain: 'copilot.tencent.com'
    };
    const r = await departBuddy(cred);
    assert.equal(r.action, 'departed');
    assert.equal(departBodies.length, 1, '应恰好提交一次 depart');
    assert.deepEqual(departBodies[0], {location_id: 3});
    assert.match(r.message, /商场店铺/);
});

test('departBuddy：config 查询失败时回退默认 location_id，仍带 body', async () => {
    const cred = {
        bearer_token: 'test-token',
        user_id: 'tester',
        domain: 'copilot.tencent.com'
    };
    departBodies.length = 0;
    configFails = true;
    const r = await departBuddy(cred);
    configFails = false;
    assert.equal(r.action, 'departed');
    assert.deepEqual(departBodies[0], {location_id: 1});
});

test.after(() => server.close());
