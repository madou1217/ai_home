'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeNativeStreamUsage,
  parseNativeStreamEvent
} = require('../lib/server/native-session-chat-stream');

function parseLines(provider, lines) {
  const state = { content: '', sessionId: '' };
  const events = [];
  for (const line of lines) {
    const event = parseNativeStreamEvent(provider, JSON.stringify(line), state);
    if (Array.isArray(event)) events.push(...event);
    else if (event) events.push(event);
  }
  return { state, events };
}

test('qoder partial stream deltas are deduped against the final assistant message', () => {
  const { state, events } = parseLines('qoder', [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想' },
          { type: 'text', text: '你好' }
        ]
      }
    }
  ]);
  assert.equal(state.content, '你好');
  assert.deepEqual(
    events.map((event) => `${event.type}:${event.delta || event.thinking || ''}`),
    ['thinking:想', 'delta:你', 'delta:好']
  );
});

test('qoder native result estimates usage from context_usage_ratio when counters are zero', () => {
  const { state } = parseLines('qoder', [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } },
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: { credits: 0.25, billable: true, context_usage_ratio: 0.1, request_id: 'req-1' }
      }
    },
    {
      type: 'result',
      subtype: 'success',
      result: '你好',
      usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.1 }
    }
  ]);
  assert.equal(state.usage.estimated, true);
  assert.equal(state.usage.inputTokens, 20000);
  assert.equal(state.usage.outputTokens, 3);
  assert.equal(state.usage.credits, 0.25);
  assert.equal(state.usage.requestId, 'req-1');
});

test('qoder native result prefers real token counters when the CLI provides them', () => {
  const usage = normalizeNativeStreamUsage({
    input_tokens: 10,
    output_tokens: 5,
    context_usage_ratio: 0.5
  }, { provider: 'qodercn', outputText: 'hello world' });
  assert.equal(usage.estimated, false);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.contextUsageRatio, 0.5);
});

test('non-qoder providers still reject all-zero usage instead of inventing tokens', () => {
  assert.equal(normalizeNativeStreamUsage({
    input_tokens: 0,
    output_tokens: 0,
    context_usage_ratio: 0.5
  }, { provider: 'claude', outputText: 'hello' }), null);
});
