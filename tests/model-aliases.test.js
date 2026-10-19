import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicToOpenAI as codebuddyAnthropicToOpenAI} from '../src/services/codebuddy/translator.js';
import {anthropicToOpenAI as relayAnthropicToOpenAI} from '../src/services/relay/translator.js';
import {anthropicToResponses as copilotAnthropicToResponses} from '../src/services/copilot/anthropic-translator.js';

function request(model) {
    return {
        model,
        messages: [{role: 'user', content: 'hello'}],
        max_tokens: 100
    };
}

test('model names pass through unchanged before upstream requests', () => {
    const cases = [
        'default',
        'best',
        'sonnet',
        'opus',
        'haiku',
        'opusplan',
        'sonnet[1m]',
        'opus[1m]',
        'deepseek-v4-pro[1m]'
    ];

    for (const model of cases) {
        assert.equal(codebuddyAnthropicToOpenAI(request(model)).model, model);
        assert.equal(relayAnthropicToOpenAI(request(model)).model, model);
        assert.equal(copilotAnthropicToResponses(request(model)).model, model);
    }
});
