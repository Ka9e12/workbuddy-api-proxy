/**
 * API Token 兼容性测试
 * 验证 Authorization: Bearer 和 x-api-key 两种传参方式均可正确鉴权
 * 以及 Authorization 优先于 x-api-key 的逻辑
 *
 * 鉴权已统一为网关鉴权（src/services/gateway/auth.js）
 * @module tests/auth-token-compat
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateGatewayRequest, getGatewayApiKeyInfo, initGatewayAuth} from '../src/services/gateway/auth.js';
import {routeCopilotRequest} from '../src/routes/copilot.js';

// 初始化网关鉴权（需要 ADMIN_PASSWORD 环境变量）
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
initGatewayAuth();

const apiKey = getGatewayApiKeyInfo().apiKeyPlain;

async function routeCopilotWithHeaders(headers) {
    let statusCode;
    let body = '';
    const req = {
        method: 'GET',
        url: '/copilot/v1/models',
        headers: {host: '127.0.0.1', ...headers},
        socket: {remoteAddress: '127.0.0.1'}
    };
    const res = {
        writeHead(status) {
            statusCode = status;
        },
        end(data = '') {
            body = data;
        }
    };

    await routeCopilotRequest(req, res);
    return {statusCode, body: JSON.parse(body)};
}

test('auth accepts Claude Code ANTHROPIC_AUTH_TOKEN through Authorization bearer', async () => {
    // 多 Key 之后返回值多了 key 字段，断言按字段比较而不是整体 deepEqual
    const result = authenticateGatewayRequest({authorization: `Bearer ${apiKey}`});
    assert.equal(result.authenticated, true);
    assert.ok(result.key && typeof result.key.id === 'string' && result.key.id.length > 0);

    // Copilot 路由使用 GitHub OAuth 而非 gateway 鉴权，因此不会返回 API Key 错误
    const copilotResult = await routeCopilotWithHeaders({authorization: `Bearer ${apiKey}`});
    assert.notEqual(copilotResult.body.error?.message, 'Invalid API Key. Check your API key or visit /copilotFE.');
});

test('auth accepts Claude Code ANTHROPIC_API_KEY through x-api-key', async () => {
    const result = authenticateGatewayRequest({'x-api-key': apiKey});
    assert.equal(result.authenticated, true);
    assert.ok(result.key && typeof result.key.id === 'string' && result.key.id.length > 0);

    const copilotResult = await routeCopilotWithHeaders({'x-api-key': apiKey});
    assert.notEqual(copilotResult.body.error?.message, 'Invalid API Key. Check your API key or visit /copilotFE.');
});

test('Authorization bearer takes precedence over x-api-key compatibility header', async () => {
    const result = authenticateGatewayRequest({authorization: `Bearer ${apiKey}`, 'x-api-key': 'sk-stale'});
    assert.equal(result.authenticated, true);
    assert.ok(result.key && typeof result.key.id === 'string' && result.key.id.length > 0);

    const copilotResult = await routeCopilotWithHeaders({authorization: `Bearer ${apiKey}`, 'x-api-key': 'sk-stale'});
    assert.notEqual(copilotResult.body.error?.message, 'Invalid API Key. Check your API key or visit /copilotFE.');
});