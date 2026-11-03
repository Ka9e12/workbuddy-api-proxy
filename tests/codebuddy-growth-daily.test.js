import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * runGrowthDaily 只做猫猫旅行：领养 → 领奖 → 派出。
 *
 * 连登兑换和抽奖被移出这个流程：抽奖次数长期为 0、连登档位兑换不出东西，
 * 每次点「执行一次」都多打几次上游请求，纯属空转。
 * 这个用例守住"不再触碰那两类接口"。
 */

const hits = [];

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(url.pathname);
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
            return send({code: 0, data: {state: 'idle', daily_limit_reached: false}});
        }
        if (url.pathname.endsWith('/buddy/travel/config')) {
            return send({code: 0, data: {locations: [{id: 1, name: '咖啡馆'}]}});
        }
        if (url.pathname.endsWith('/buddy/travel/depart')) {
            return send({code: 0, data: {location: {name: '咖啡馆'}}});
        }
        // 连登/抽奖相关接口一律记下来，测试断言它们不该被调用
        send({code: 0, data: {}});
    });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.CODEBUDDY_GROWTH_BASE = `http://127.0.0.1:${server.address().port}/activity/growth/`;

const {runGrowthDaily} = await import('../src/services/codebuddy/growth.js');

test('runGrowthDaily 只做猫猫旅行，不碰连登兑换与抽奖', async () => {
    hits.length = 0;
    const cred = {bearer_token: 'test-token', user_id: 'tester', domain: 'copilot.tencent.com'};
    const result = await runGrowthDaily(cred);

    assert.equal(result.userId, 'tester');
    assert.equal(result.buddyName, '暴富喵', '要带回猫名供弹窗显示');
    assert.ok(!('streak' in result), '结果里不该再有 streak 字段');

    const joined = hits.join(' ');
    assert.ok(!/\/redeem/.test(joined), '不该调用连登兑换: ' + joined);
    assert.ok(!/\/lottery\//.test(joined), '不该调用抽奖: ' + joined);
    assert.ok(!/\/streak/.test(joined), '不该查连登状态: ' + joined);

    // 该做的三件事仍然做了
    assert.ok(hits.some((h) => h.endsWith('/buddy/info')));
    assert.ok(hits.some((h) => h.endsWith('/buddy/travel/status')));
    assert.ok(hits.some((h) => h.endsWith('/buddy/travel/depart')));
});

test('企业站/国际站直接跳过', async () => {
    hits.length = 0;
    const cred = {bearer_token: 't', user_id: 'intl', domain: 'www.codebuddy.ai'};
    const result = await runGrowthDaily(cred);
    assert.equal(result.skipped, true);
    assert.equal(hits.length, 0, '不该发出任何请求');
});

test.after(() => server.close());
