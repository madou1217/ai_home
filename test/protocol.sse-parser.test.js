'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAnthropicSseEvents,
  parseOpenAISseChunks
} = require('../lib/protocol/sse-parser');

test('SSE parser reads OpenAI data frames and ignores done or malformed chunks', () => {
  const raw = [
    'data: {"id":"chunk_1","choices":[]}',
    '',
    'data: {malformed',
    '',
    'data: [DONE]',
    '',
    'data: {"id":"chunk_2"}',
    ''
  ].join('\n');

  assert.deepEqual(parseOpenAISseChunks(raw), [
    { id: 'chunk_1', choices: [] },
    { id: 'chunk_2' }
  ]);
});

test('SSE parser reads Anthropic event names with JSON payloads', () => {
  const raw = [
    'event: message_start',
    'data: {"type":"message_start"}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
    '',
    'event: malformed',
    'data: {bad',
    ''
  ].join('\n');

  assert.deepEqual(parseAnthropicSseEvents(raw), [
    { event: 'message_start', data: { type: 'message_start' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { text: 'hi' } } }
  ]);
});
