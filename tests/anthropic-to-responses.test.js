import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicToResponses} from '../src/services/copilot/anthropic-translator.js';

test('converts Anthropic messages directly to Responses payload', () => {
    const result = anthropicToResponses({
        model: 'claude-sonnet-4-20250514',
        system: [{type: 'text', text: 'You are concise.', cache_control: {type: 'ephemeral'}}],
        max_tokens: 1200,
        stream: true,
        tools: [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}
        }],
        tool_choice: {type: 'tool', name: 'read_file'},
        messages: [
            {role: 'user', content: 'Open package.json'},
            {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'package.json'}}]},
            {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"demo"}'}, {type: 'text', text: 'Summarize it'}]}
        ]
    });

    assert.equal(result.model, 'claude-sonnet-4');
    assert.equal(result.stream, true);
    assert.equal(result.max_output_tokens, 1200);
    assert.match(result.instructions, /You are concise/);
    assert.deepEqual(result.tools, [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}
    }]);
    assert.deepEqual(result.tool_choice, {type: 'function', name: 'read_file'});
    assert.equal(result.input[0].role, 'user');
    assert.equal(result.input[1].type, 'function_call');
    assert.equal(result.input[1].call_id, 'toolu_1');
    assert.equal(result.input[2].type, 'function_call_output');
    assert.equal(result.input[2].call_id, 'toolu_1');
    assert.equal(result.input[3].role, 'user');
});
