import test from 'node:test';
import assert from 'node:assert/strict';
import {pruneOrphanToolMessages} from '../src/services/codebuddy/tool-pairing.js';

/**
 * 工具调用消息配对清理（与"参数残缺"是不同维度）：
 * 管的是 assistant.tool_calls 与 role:'tool' 消息之间的配对关系。
 */

test('干净输入 → changed=false 且返回同一引用（零字节差异）', () => {
    const input = [
        {role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'f', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'c1', content: 'ok'}
    ];
    const out = pruneOrphanToolMessages(input);
    assert.equal(out.changed, false);
    assert.equal(out.messages, input, '无改动必须返回同一引用');
});

test('孤儿 tool 消息（无对应 tool_calls）被丢弃', () => {
    const input = [
        {role: 'user', content: 'hi'},
        {role: 'tool', tool_call_id: 'ghost', content: 'orphan'}
    ];
    const out = pruneOrphanToolMessages(input);
    assert.equal(out.changed, true);
    assert.equal(out.droppedToolMessages, 1);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
});

test('孤儿 tool_calls（无结果）补中性占位，紧跟其后', () => {
    const input = [
        {role: 'assistant', content: null, tool_calls: [{id: 'c9', type: 'function', function: {name: 'f', arguments: '{}'}}]},
        {role: 'user', content: 'next'}
    ];
    const out = pruneOrphanToolMessages(input);
    assert.equal(out.changed, true);
    assert.equal(out.placeholders, 1);
    assert.equal(out.messages[1].role, 'tool');
    assert.equal(out.messages[1].tool_call_id, 'c9');
    assert.equal(typeof out.messages[1].content, 'string');
    assert.equal(out.messages[2].role, 'user');
});

test('占位内容为纯文本（非 JSON），避免 sortJsonString 参与', () => {
    const input = [{role: 'assistant', content: null, tool_calls: [{id: 'c1', function: {name: 'f', arguments: '{}'}}]}];
    const out = pruneOrphanToolMessages(input);
    const ph = out.messages[1].content;
    assert.throws(() => JSON.parse(ph), '占位不应是合法 JSON');
});

test('部分应答：只丢/补真正孤儿的那部分', () => {
    const input = [
        {role: 'assistant', content: null, tool_calls: [
            {id: 'a', function: {name: 'f', arguments: '{}'}},
            {id: 'b', function: {name: 'g', arguments: '{}'}}
        ]},
        {role: 'tool', tool_call_id: 'a', content: 'ok'},
        {role: 'tool', tool_call_id: 'zzz', content: 'stray'}
    ];
    const out = pruneOrphanToolMessages(input);
    assert.equal(out.droppedToolMessages, 1, 'stray 应被丢弃');
    assert.equal(out.placeholders, 1, 'b 应被补占位');
    const toolIds = out.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    assert.deepEqual(toolIds, ['a', 'b']);
});

test('幂等：清理后的结果再清理 → changed=false', () => {
    const input = [
        {role: 'assistant', content: null, tool_calls: [{id: 'c1', function: {name: 'f', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'ghost', content: 'x'}
    ];
    const once = pruneOrphanToolMessages(input);
    const twice = pruneOrphanToolMessages(once.messages);
    assert.equal(twice.changed, false, '二次清理不应再有改动');
    assert.equal(twice.messages, once.messages);
});

test('空数组/非数组输入安全', () => {
    assert.equal(pruneOrphanToolMessages([]).changed, false);
    assert.equal(pruneOrphanToolMessages(null).changed, false);
});
