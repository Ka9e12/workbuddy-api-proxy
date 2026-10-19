import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeConversationKey,
    extractConversationKeyFromPayload,
    extractConversationKey
} from '../src/routes/relay.js';

test('normalizeConversationKey 过滤空字符串和非字符串', () => {
    assert.equal(normalizeConversationKey(''), undefined);
    assert.equal(normalizeConversationKey('   '), undefined);
    assert.equal(normalizeConversationKey(null), undefined);
    assert.equal(normalizeConversationKey(undefined), undefined);
    assert.equal(normalizeConversationKey(123), undefined);
    assert.equal(normalizeConversationKey('  abc  '), 'abc');
});

test('extractConversationKeyFromPayload 优先 conversation_id', () => {
    const r = extractConversationKeyFromPayload({
        conversation_id: 'conv-1',
        session_id: 'sess-1',
        metadata: {thread_id: 'thread-1'}
    });
    assert.equal(r, 'conv-1');
});

test('extractConversationKeyFromPayload 回退到 metadata 字段', () => {
    const r = extractConversationKeyFromPayload({
        metadata: {sessionId: 'meta-sess'}
    });
    assert.equal(r, 'meta-sess');
});

test('extractConversationKeyFromPayload 无任何字段返回 undefined', () => {
    assert.equal(extractConversationKeyFromPayload({}), undefined);
    assert.equal(extractConversationKeyFromPayload(null), undefined);
});

test('extractConversationKey 优先从 x-conversation-id 头取值', () => {
    const req = {headers: {'x-conversation-id': 'header-conv'}};
    const payload = {conversation_id: 'payload-conv', messages: [{role: 'user', content: 'hi'}]};
    assert.equal(extractConversationKey(req, payload), 'header-conv');
});

test('extractConversationKey 头缺失时回退到 payload 字段', () => {
    const req = {headers: {}};
    const payload = {session_id: 'payload-sess', messages: [{role: 'user', content: 'hi'}]};
    assert.equal(extractConversationKey(req, payload), 'payload-sess');
});

test('extractConversationKey 头和 payload 都缺失时回退到 anchor key', () => {
    const req = {headers: {}};
    const payload = {messages: [{role: 'user', content: 'first question'}]};
    const key = extractConversationKey(req, payload);
    assert.match(key, /^anchor-[a-z0-9]+$/);
});

test('extractConversationKey 同一 payload 多轮追加后 anchor key 保持稳定', () => {
    const req = {headers: {}};
    const payload1 = {messages: [{role: 'user', content: 'first question'}]};
    const payload2 = {messages: [
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'answer'},
        {role: 'user', content: 'follow up'}
    ]};
    assert.equal(extractConversationKey(req, payload1), extractConversationKey(req, payload2));
});

test('extractConversationKey 支持 Responses API 的 input 字段', () => {
    const req = {headers: {}};
    const payload = {input: [{role: 'user', content: 'responses input'}]};
    const key = extractConversationKey(req, payload);
    assert.match(key, /^anchor-[a-z0-9]+$/);
});
