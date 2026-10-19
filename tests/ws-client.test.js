import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWebSocketPayload} from '../src/services/copilot/copilot-ws-client.js';

test('prepareWebSocketPayload removes HTTP transport fields', () => {
    const payload = prepareWebSocketPayload({
        model: 'gpt-4.1',
        stream: true,
        background: false,
        input: [{role: 'user', content: [{type: 'input_text', text: 'hi'}]}]
    });

    assert.deepEqual(payload, {
        model: 'gpt-4.1',
        input: [{role: 'user', content: [{type: 'input_text', text: 'hi'}]}]
    });
});

test('prepareWebSocketPayload removes Responses fields unsupported by Copilot WS', () => {
    const payload = prepareWebSocketPayload({
        model: 'gpt-4.1',
        input: 'hi',
        include: ['reasoning.encrypted_content'],
        store: false,
        truncation: 'auto',
        user: 'codex',
        metadata: {session_id: 'session_1'},
        parallel_tool_calls: true,
        text: {format: {type: 'text'}},
        reasoning: {effort: 'medium'},
        max_output_tokens: 1024
    });

    assert.deepEqual(payload, {
        model: 'gpt-4.1',
        input: 'hi',
        parallel_tool_calls: true,
        reasoning: {effort: 'medium'},
        max_output_tokens: 1024
    });
});
