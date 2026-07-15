'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readOpenAIResponseFunctionCallId,
  rememberToolCallRefs,
  resolveOpenAIResponseFunctionOutputId,
  resolveToolResultId,
  resolveToolResultRef
} = require('../lib/protocol/tool-call-pairing');

test('tool call pairing resolves duplicate generic tool names in call order', () => {
  const pending = [];
  const calls = rememberToolCallRefs([
    { name: 'CustomLookup', arguments: '{"query":"first"}' },
    { name: 'CustomLookup', arguments: '{"query":"second"}' }
  ], pending, {
    createFallbackId: (_part, index) => `call_${index + 1}`
  });

  assert.deepEqual(calls.map((call) => call.id), ['call_1', 'call_2']);
  assert.equal(resolveToolResultId({ name: 'CustomLookup' }, pending), 'call_1');
  assert.equal(resolveToolResultId({ name: 'CustomLookup' }, pending), 'call_2');
});

test('tool result pairing preserves explicit ids and recovers names from pending refs', () => {
  const pending = [];
  rememberToolCallRefs([{ id: 'toolu_lookup_1', name: 'CustomLookup' }], pending);

  assert.deepEqual(resolveToolResultRef({ toolCallId: 'toolu_lookup_1' }, pending), {
    id: 'toolu_lookup_1',
    name: 'CustomLookup'
  });
});

test('OpenAI Responses function outputs consume pending call ids FIFO when ids are omitted', () => {
  const pending = [
    readOpenAIResponseFunctionCallId({ type: 'function_call', name: 'CustomLookup' }, 0),
    readOpenAIResponseFunctionCallId({ type: 'function_call', name: 'CustomLookup' }, 1)
  ];

  assert.deepEqual(pending, ['call_1', 'call_2']);
  assert.equal(resolveOpenAIResponseFunctionOutputId({ type: 'function_call_output' }, pending), 'call_1');
  assert.equal(resolveOpenAIResponseFunctionOutputId({ type: 'function_call_output' }, pending), 'call_2');
});
