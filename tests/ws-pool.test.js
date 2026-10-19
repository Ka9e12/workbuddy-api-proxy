import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionPoolKey} from '../src/services/copilot/copilot-ws-pool.js';

test('connectionPoolKey separates direct and proxied WebSocket connections', () => {
    const directKey = connectionPoolKey('copilot-token', null);
    const proxiedKey = connectionPoolKey('copilot-token', 'http://127.0.0.1:7890');

    assert.notEqual(directKey, proxiedKey);
});

test('connectionPoolKey separates different proxy endpoints', () => {
    const firstProxyKey = connectionPoolKey('copilot-token', 'http://127.0.0.1:7890');
    const secondProxyKey = connectionPoolKey('copilot-token', 'socks5://127.0.0.1:7891');

    assert.notEqual(firstProxyKey, secondProxyKey);
});
