import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * 领奖：要把礼物详情带回来，供面板弹窗展示"带回了什么"。
 *
 * 字段优先级是领奖接口响应 > 领奖前查到的 status。
 * 上游响应结构不保证稳定，所以每个字段独立回退——最坏情况也要能显示积分。
 */

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const send = (obj) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(obj));
        };
        if (url.pathname.endsWith('/buddy/info')) {
            return send({code: 0, data: {buddy: {name: '暴富喵'}}});
        }
        if (url.pathname.endsWith('/buddy/travel/status')) {
            return send({code: 0, data: statusPayload});
        }
        if (url.pathname.endsWith('/buddy/travel/claim')) {
            claimCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            return send({code: 0, data: claimPayload});
        }
        send({code: 0, data: {}});
    });
});

const claimCalls = [];
let statusPayload = {};
let claimPayload = {};

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.CODEBUDDY_GROWTH_BASE = `http://127.0.0.1:${server.address().port}/activity/growth/`;

const {claimTravelReward} = await import('../src/services/codebuddy/growth.js');

const cred = {bearer_token: 'test-token', user_id: 'tester', domain: 'copilot.tencent.com'};

test('领奖响应体优先于领奖前快照', async () => {
    claimCalls.length = 0;
    statusPayload = {state: 'arrived', record_id: 77, reward_credit: 50, location: {name: '咖啡馆'}};
    claimPayload = {reward_credit: 62, location: {name: '商场店铺'}};

    const r = await claimTravelReward(cred);
    assert.equal(r.action, 'claimed');
    assert.equal(r.credit, 62, '应取领奖响应的实际到账积分');
    assert.equal(r.locationName, '商场店铺');
    assert.equal(claimCalls.length, 1);
    assert.equal(claimCalls[0].record_id, 77);
});

test('领奖响应缺字段时回退到 status 快照', async () => {
    claimCalls.length = 0;
    statusPayload = {state: 'arrived', record_id: 88, reward_credit: 50, location: {name: '咖啡馆'}};
    claimPayload = {};

    const r = await claimTravelReward(cred);
    assert.equal(r.credit, 50);
    assert.equal(r.locationName, '咖啡馆');
});

test('status 带 letter 时透传给前端', async () => {
    claimCalls.length = 0;
    statusPayload = {
        state: 'arrived',
        record_id: 99,
        reward_credit: 8,
        letter: {content: '在咖啡馆遇到了一只晒太阳的猫。'}
    };
    claimPayload = {};

    const r = await claimTravelReward(cred);
    assert.deepEqual(r.letter, {content: '在咖啡馆遇到了一只晒太阳的猫。'});
});

test('非 arrived 状态不提交领奖请求', async () => {
    claimCalls.length = 0;
    statusPayload = {state: 'idle', record_id: 0};
    claimPayload = {reward_credit: 999};

    const r = await claimTravelReward(cred);
    assert.equal(r.action, 'skip');
    assert.equal(r.credit, 0);
    assert.equal(claimCalls.length, 0, '不该发 claim 请求');
});

test('traveling 状态同样不提交', async () => {
    claimCalls.length = 0;
    statusPayload = {state: 'traveling', record_id: 0};
    const r = await claimTravelReward(cred);
    assert.equal(r.action, 'skip');
    assert.equal(claimCalls.length, 0);
});

test.after(() => server.close());
