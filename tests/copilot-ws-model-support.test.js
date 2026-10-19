import test from 'node:test';
import assert from 'node:assert/strict';
import {supportsResponsesWebSocket} from '../src/routes/copilot.js';

test('supportsResponsesWebSocket allows GPT-series models', () => {
    assert.equal(supportsResponsesWebSocket('gpt-4.1'), true);
    assert.equal(supportsResponsesWebSocket('gpt-5-mini'), true);
    assert.equal(supportsResponsesWebSocket('GPT-5'), true);
});

test('supportsResponsesWebSocket rejects non-GPT models', () => {
    assert.equal(supportsResponsesWebSocket('claude-sonnet-4'), false);
    assert.equal(supportsResponsesWebSocket('o3-mini'), false);
    assert.equal(supportsResponsesWebSocket(''), false);
    assert.equal(supportsResponsesWebSocket(undefined), false);
});
