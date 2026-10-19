import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {aggregateStreamResponse} from '../src/services/codebuddy/api.js';

/**
 * 工具调用参数完整性：上游截断时（finish_reason=length）arguments 会是残缺 JSON。
 * 本模块必须"丢弃残缺调用、绝不补全伪造"，否则下游会拿残缺参数执行错误命令。
 */

function sseChunks(chunks) {
    // 把若干 SSE data 行合成一个可读流
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return Readable.from([Buffer.from(body, 'utf8')]);
}

test('完整可解析的 tool_call 参数被保留', async () => {
    const stream = sseChunks([
        {choices: [{delta: {tool_calls: [{index: 0, id: 'c1', function: {name: 'do_it', arguments: '{"a":1}'}}]}}]},
        {choices: [{delta: {}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 1, completion_tokens: 1}}
    ]);
    const agg = await aggregateStreamResponse(stream);
    assert.equal(agg.toolCalls.length, 1);
    assert.equal(agg.toolCalls[0].function.name, 'do_it');
    assert.equal(agg.toolCalls[0].function.arguments, '{"a":1}');
});

test('残缺 JSON 的 tool_call 被丢弃（不补全）', async () => {
    const stream = sseChunks([
        {choices: [{delta: {tool_calls: [{index: 0, id: 'c1', function: {name: 'do_it', arguments: '{"a":'}}]}}]},
        {choices: [{delta: {}, finish_reason: 'length'}], usage: {prompt_tokens: 1, completion_tokens: 1}}
    ]);
    const agg = await aggregateStreamResponse(stream);
    assert.equal(agg.toolCalls.length, 0, '残缺调用必须被丢弃');
});

test('空 arguments 的 tool_call 保留（无参数是合法的）', async () => {
    const stream = sseChunks([
        {choices: [{delta: {tool_calls: [{index: 0, id: 'c1', function: {name: 'noargs', arguments: ''}}]}}]},
        {choices: [{delta: {}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 1, completion_tokens: 1}}
    ]);
    const agg = await aggregateStreamResponse(stream);
    assert.equal(agg.toolCalls.length, 1);
});

test('多工具调用中只丢残缺的，保留完整的', async () => {
    const stream = sseChunks([
        {choices: [{delta: {tool_calls: [
            {index: 0, id: 'c1', function: {name: 'good', arguments: '{"x":1}'}},
            {index: 1, id: 'c2', function: {name: 'bad', arguments: '{"y":'}}
        ]}}]},
        {choices: [{delta: {}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 1, completion_tokens: 1}}
    ]);
    const agg = await aggregateStreamResponse(stream);
    assert.equal(agg.toolCalls.length, 1);
    assert.equal(agg.toolCalls[0].function.name, 'good');
});
