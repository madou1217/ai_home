'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptKimiChatRequestBuffer } = require('../lib/server/kimi-chat-request');
const adapt = (value) => JSON.parse(adaptKimiChatRequestBuffer(Buffer.from(JSON.stringify(value))));

test('generic OpenAI reasoning and output budget become native Kimi parameters', () => {
  assert.deepEqual(adapt({ model: 'k3', reasoning_effort: 'max', max_tokens: 131072, stream: true }), {
    model: 'k3', thinking: { type: 'enabled', effort: 'max' }, max_completion_tokens: 131072, stream: true
  });
  assert.deepEqual(adapt({ reasoning_effort: 'none' }), { thinking: { type: 'disabled' } });
});

test('explicit native Kimi settings win and requests without aliases remain byte-identical', () => {
  assert.deepEqual(adapt({ reasoning_effort: 'low', max_tokens: 1,
    thinking: { type: 'enabled', effort: 'max', keep: 'all' }, max_completion_tokens: 12345 }), {
    thinking: { type: 'enabled', effort: 'max', keep: 'all' }, max_completion_tokens: 12345
  });
  for (const text of ['{ "model": "unknown-model", "stream": true }', 'invalid']) {
    const buffer = Buffer.from(text);
    assert.equal(adaptKimiChatRequestBuffer(buffer), buffer);
  }
});

test('missing Kimi output budget uses the pinned model limit, while explicit budgets win', () => {
  assert.equal(adapt({ model: 'k3', stream: true }).max_completion_tokens, 131072);
  assert.equal(adapt({ model: 'k3', max_completion_tokens: 12 }).max_completion_tokens, 12);
  assert.equal(adapt({ model: 'k3', max_tokens: 13 }).max_completion_tokens, 13);
});
