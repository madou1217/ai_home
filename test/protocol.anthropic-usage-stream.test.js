'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSseTransformStream, convertSseViaCanonical } = require('../lib/server/protocol-stream-pipeline');

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const parse = (text) => text.split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6)));

// MTPLX 等上游：message_start 报 0，真实输入量（含命中缓存的部分）在 message_delta 里。
const lateUsageStream = [
  sse('message_start', { message: { id: 'msg_1', model: 'qwen3.8-27b', usage: { input_tokens: 0, output_tokens: 0 } } }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '蔚蓝' } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 60 } }),
  sse('message_stop', {})
].join('');

test('Anthropic usage reported late in message_delta reaches the Responses stream', () => {
  const chunks = [];
  const stream = createSseTransformStream('anthropic_messages', 'openai_responses', { onChunk: (chunk) => chunks.push(chunk) });
  stream.write(lateUsageStream);
  stream.end();
  const completed = parse(chunks.join('')).filter((event) => event.type === 'response.completed');
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].response.usage, { input_tokens: 15, output_tokens: 60, total_tokens: 75 });
});

test('buffered Anthropic to Responses conversion keeps late input usage and cache reads', () => {
  const events = parse(convertSseViaCanonical('anthropic_messages', 'openai_responses', lateUsageStream, 'qwen3.8-27b'));
  const completed = events.find((event) => event.type === 'response.completed');
  assert.deepEqual(completed.response.usage, { input_tokens: 15, output_tokens: 60, total_tokens: 75 });
});
