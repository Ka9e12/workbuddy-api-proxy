import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createStreamState,
    responsesEventToAnthropicEvents,
    translateStreamChunk
} from '../src/services/copilot/anthropic-translator.js';
import {createChatCompletionsStreamState} from '../src/transformer/responses-translator.js';

test('emits input_json_delta when first tool call chunk includes arguments', () => {
    const state = createStreamState();
    const events = translateStreamChunk({
        id: 'chatcmpl_1',
        model: 'gpt-4.1',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                        name: 'read_file',
                        arguments: '{"path":"package.json"}'
                    }
                }]
            },
            finish_reason: null
        }]
    }, state);

    assert.deepEqual(events.map((event) => event.type), [
        'message_start',
        'content_block_start',
        'content_block_delta'
    ]);
    assert.equal(events[1].content_block.type, 'tool_use');
    assert.equal(events[1].content_block.id, 'call_1');
    assert.equal(events[1].content_block.name, 'read_file');
    assert.deepEqual(events[2].delta, {
        type: 'input_json_delta',
        partial_json: '{"path":"package.json"}'
    });
});

test('closes text block before starting tool call block', () => {
    const state = createStreamState();

    const textEvents = translateStreamChunk({
        id: 'chatcmpl_2',
        model: 'gpt-4.1',
        choices: [{
            index: 0,
            delta: {content: '我先快速梳理项目结构。'},
            finish_reason: null
        }]
    }, state);

    const toolEvents = translateStreamChunk({
        id: 'chatcmpl_2',
        model: 'gpt-4.1',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_2',
                    type: 'function',
                    function: {
                        name: 'list_files',
                        arguments: '{"path":"."}'
                    }
                }]
            },
            finish_reason: null
        }]
    }, state);

    assert.deepEqual(textEvents.map((event) => event.type), [
        'message_start',
        'content_block_start',
        'content_block_delta'
    ]);
    assert.deepEqual(toolEvents.map((event) => event.type), [
        'content_block_stop',
        'content_block_start',
        'content_block_delta'
    ]);
    assert.equal(toolEvents[0].index, 0);
    assert.equal(toolEvents[1].index, 1);
    assert.equal(toolEvents[1].content_block.type, 'tool_use');
    assert.deepEqual(toolEvents[2].delta, {
        type: 'input_json_delta',
        partial_json: '{"path":"."}'
    });
});

test('waits for tool name before emitting Anthropic tool_use block', () => {
    const state = createStreamState();

    const earlyEvents = translateStreamChunk({
        id: 'chatcmpl_3',
        model: 'gpt-4.1',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_3',
                    type: 'function',
                    function: {
                        arguments: '{"path"'
                    }
                }]
            },
            finish_reason: null
        }]
    }, state);

    const namedEvents = translateStreamChunk({
        id: 'chatcmpl_3',
        model: 'gpt-4.1',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {
                        name: 'read_file',
                        arguments: ':"README.md"}'
                    }
                }]
            },
            finish_reason: null
        }]
    }, state);

    assert.deepEqual(earlyEvents.map((event) => event.type), ['message_start']);
    assert.deepEqual(namedEvents.map((event) => event.type), [
        'content_block_start',
        'content_block_delta'
    ]);
    assert.equal(namedEvents[0].content_block.name, 'read_file');
    assert.deepEqual(namedEvents[1].delta, {
        type: 'input_json_delta',
        partial_json: '{"path":"README.md"}'
    });
});

test('converts completed-only Responses function call to Anthropic tool_use stream', () => {
    const events = responsesEventToAnthropicEvents(
        'response.completed',
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.4',
                output: [{
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'list_files',
                    arguments: '{"path":"."}'
                }],
                usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15}
            }
        },
        createChatCompletionsStreamState(),
        createStreamState()
    );

    assert.deepEqual(events.map((event) => event.type), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop'
    ]);
    assert.equal(events[1].content_block.type, 'tool_use');
    assert.equal(events[1].content_block.name, 'list_files');
    assert.deepEqual(events[2].delta, {
        type: 'input_json_delta',
        partial_json: '{"path":"."}'
    });
    assert.equal(events[4].delta.stop_reason, 'tool_use');
});
