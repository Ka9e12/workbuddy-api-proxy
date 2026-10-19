import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeResponsesInput} from '../src/transformer/responses-translator.js';

test('sanitizeResponsesInput removes previous response text part references from message content', () => {
    const sanitized = sanitizeResponsesInput([
        {
            type: 'message',
            id: 'msg_prev',
            status: 'completed',
            role: 'assistant',
            content: [
                {
                    type: 'output_text',
                    id: 'MUL0xll7F6Jf7PoXj7bs2zL9fwEbVS+WMkG94nrgldVxJeLjXybDQpQ3sAlAW762v3sKlG1J217nIIy+NRWx5BXlvZkaIMBOX6JC0otE6jp2orviH1ArMUuMZFn5XVR5ymhayydhxT59/0zJa2dY9R7RikrYTY6W39o4R5rDWLH4tMwHYROgY3G74khcJWHfDFrLdYoZP4/OGqzYA4/OmZvoTdxdHDe7lzIOFvLdsX1fe4nj/lGX6jv3160CHHDeV4IB/Yy3EqMfbLA+XvFPquiO3tKsHbPBwR2zJa8IobpX8BHqzmxZslnrB3ztiWR5TUvbRuBV1Pp31C7hGMGa2x685wr11g6DKTDyZ6SDdR8XnU+KVCuJ7iKefvW50gdzG1mYTevR4MVzHhVk0KunOXRprYM0/Il5YS+KlL9qr9CcCKLCdQo1KUrx7ELrvF2fV29V9dH1OsY+C26Mexcvk/khqvX',
                    text: 'previous assistant text',
                    annotations: [],
                    status: 'completed'
                }
            ]
        }
    ]);

    assert.deepEqual(sanitized, [
        {
            role: 'assistant',
            content: [
                {
                    type: 'output_text',
                    text: 'previous assistant text'
                }
            ]
        }
    ]);
});

test('sanitizeResponsesInput removes nested reference fields that point to previous response parts', () => {
    const sanitized = sanitizeResponsesInput([
        {
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'continue',
                    reference: 'MUL0xll7F6Jf7PoXj7bs2zL9fwEbVS+WMkG94nrgldVxJeLjXybDQpQ3sAlAW762v3sKlG1J217nIIy+NRWx5BXlvZkaIMBOX6JC0otE6jp2orviH1ArMUuMZFn5XVR5ymhayydhxT59/0zJa2dY9R7RikrYTY6W39o4R5rDWLH4tMwHYROgY3G74khcJWHfDFrLdYoZP4/OGqzYA4/OmZvoTdxdHDe7lzIOFvLdsX1fe4nj/lGX6jv3160CHHDeV4IB/Yy3EqMfbLA+XvFPquiO3tKsHbPBwR2zJa8IobpX8BHqzmxZslnrB3ztiWR5TUvbRuBV1Pp31C7hGMGa2x685wr11g6DKTDyZ6SDdR8XnU+KVCuJ7iKefvW50gdzG1mYTevR4MVzHhVk0KunOXRprYM0/Il5YS+KlL9qr9CcCKLCdQo1KUrx7ELrvF2fV29V9dH1OsY+C26Mexcvk/khqvX'
                }
            ]
        }
    ]);

    assert.deepEqual(sanitized, [
        {
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'continue'
                }
            ]
        }
    ]);
});
