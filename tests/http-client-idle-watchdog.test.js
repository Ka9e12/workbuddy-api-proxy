import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {request, isNetworkError, UpstreamIdleTimeout} from '../src/utils/http-client.js';

/**
 * 流空闲超时：区分"上游在慢慢吐 token"（不该断）与"上游卡死"（该断）。
 *
 * 这里**只测真实 HTTP 路径**：曾有一个自造看门狗的单测（用 PassThrough 手动 write）
 * 全部通过，但生产路径照样误杀所有请求——因为单测绕过了真实的流消费模式。
 * 因此本文件只保留走 request() 的端到端用例。
 */


/**
 * 回归：慢速但**持续**的流（每个 chunk 间隔都小于 idleTimeout）不能被误杀。
 * 这条覆盖真实生产消费方式（for await），曾因看门狗监听 'readable' 而非 'data'
 * 导致流进入 flowing 模式后事件永不触发、计时器永不清零、到点必然误报。
 */
test('回归：真实 HTTP 慢速持续流不被 idleTimeout 误杀（for await 消费）', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        let n = 0;
        const t = setInterval(() => {
            res.write(`data: {"n":${n}}\n\n`);
            if (++n >= 6) {
                clearInterval(t);
                res.end();
            }
        }, 100);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        // 阈值 250ms，而 chunk 间隔 100ms → 绝不能触发
        const resp = await request(`http://127.0.0.1:${port}/x`, {method: 'GET', timeout: 5000, idleTimeout: 250});
        let body = '';
        let err = null;
        try {
            for await (const c of resp.body) body += c.toString();
        } catch (e) {
            err = e;
        }
        assert.equal(err, null, `慢速持续流不应被中断: ${err && err.message}`);
        assert.match(body, /"n":5/, '应完整读到最后一个 chunk');
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

/**
 * 回归：非流式小响应（billing/growth 这类）不得因"没有流式活动"被误判空闲。
 */
test('回归：非流式小响应正常返回（不误报 idle）', async () => {
    const server = http.createServer((req, res) => {
        setTimeout(() => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end('{"ok":true}');
        }, 200);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const resp = await request(`http://127.0.0.1:${port}/x`, {method: 'POST', body: '{}', timeout: 20000});
        let body = '';
        for await (const c of resp.body) body += c.toString();
        assert.equal(body, '{"ok":true}');
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

test('集成：idleTimeout 触发 UpstreamIdleTimeout 且属网络错误', async () => {
    // 假上游：写一帧后永久静默
    const server = http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        // 之后不写、不结束
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const resp = await request(`http://127.0.0.1:${port}/x`, {method: 'GET', idleTimeout: 60, timeout: 5000});
        const err = await new Promise((resolve) => {
            resp.body.on('data', () => {});
            resp.body.on('error', resolve);
        });
        assert.equal(err.name, 'UpstreamIdleTimeout');
        assert.equal(isNetworkError(err), true, 'idle 超时必须被判定为网络错误（不罚账号）');
        assert.equal(err.idleMs, 60);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

test('回归：idleTimeout 默认关闭时慢速但持续的流能完整读完', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        let n = 0;
        const t = setInterval(() => {
            res.write('chunk');
            if (++n >= 4) {
                clearInterval(t);
                res.end();
            }
        }, 30);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const resp = await request(`http://127.0.0.1:${port}/x`, {method: 'GET', timeout: 5000});
        const chunks = [];
        await new Promise((resolve, reject) => {
            resp.body.on('data', (c) => chunks.push(c));
            resp.body.on('end', resolve);
            resp.body.on('error', reject);
        });
        assert.equal(Buffer.concat(chunks).toString('utf8'), 'chunkchunkchunkchunk');
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

test('回归：未传 idleTimeout 时请求超时语义不变（首字节超时仍生效）', async () => {
    const server = http.createServer(() => {
        /* 不响应，模拟首字节超时 */
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        await assert.rejects(
            () => request(`http://127.0.0.1:${port}/x`, {method: 'GET', timeout: 80}),
            (err) => isNetworkError(err)
        );
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});
