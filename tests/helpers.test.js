import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUrl} from '../src/utils/helpers.js';

test('buildUrl keeps a single v1 segment when endpoint requires v1', () => {
    assert.equal(buildUrl('https://api.example.com', 'v1/messages'), 'https://api.example.com/v1/messages');
    assert.equal(buildUrl('https://api.example.com/v1', 'v1/messages'), 'https://api.example.com/v1/messages');
    assert.equal(buildUrl('https://api.example.com/v1/', '/v1/messages'), 'https://api.example.com/v1/messages');
    assert.equal(buildUrl('https://api.example.com/v1/v1', 'v1/messages'), 'https://api.example.com/v1/messages');
});
