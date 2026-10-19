'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QODER_CONTEXT_WINDOW_TOKENS,
  estimateQoderUsage,
  estimateTextTokens,
  extractAssistantText,
  qoderEstimatedSourceKind,
  readQoderUsageDetails,
  toOpenAiUsage
} = require('../lib/usage/qoder-usage');

test('estimateTextTokens counts CJK per character and non-CJK per four characters', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('hello world!'), 3);
  assert.equal(estimateTextTokens('你好世界'), 4);
  assert.equal(estimateTextTokens('你好 world'), 2 + 2);
});

test('readQoderUsageDetails reads the fields qodercli actually returns', () => {
  const details = readQoderUsageDetails({
    input_tokens: 0,
    output_tokens: 0,
    credits: 1.25,
    original_credits: 2,
    billable: true,
    context_usage_ratio: 0.2014,
    request_id: 'req-1'
  });
  assert.deepEqual(details, {
    contextUsageRatio: 0.2014,
    credits: 1.25,
    originalCredits: 2,
    requestId: 'req-1',
    billable: true
  });
  assert.equal(readQoderUsageDetails({ input_tokens: 10 }), null);
});

test('estimateQoderUsage converts context ratio into input tokens and keeps billing evidence', () => {
  const estimated = estimateQoderUsage({
    usage: {
      credits: 1,
      billable: true,
      context_usage_ratio: 0.2014,
      request_id: 'req-1'
    },
    outputText: '这是一段回答'
  });
  assert.equal(QODER_CONTEXT_WINDOW_TOKENS, 200000);
  assert.equal(estimated.inputTokens, 40280);
  assert.equal(estimated.outputTokens, 6);
  assert.equal(estimated.totalTokens, 40286);
  assert.equal(estimated.credits, 1);
  assert.equal(estimated.billable, true);
  assert.equal(estimated.requestId, 'req-1');
  assert.equal(estimated.estimated, true);
});

test('estimateQoderUsage falls back to prompt text only when no context ratio exists', () => {
  const estimated = estimateQoderUsage({
    details: { contextUsageRatio: 0, credits: 0, originalCredits: 0, requestId: '', billable: null },
    promptText: 'hello',
    outputText: 'world'
  });
  assert.equal(estimated.inputTokens, 2);
  assert.equal(estimated.outputTokens, 2);
});

test('estimateQoderUsage returns null when there is no evidence at all', () => {
  assert.equal(estimateQoderUsage({}), null);
  assert.equal(estimateQoderUsage({ outputText: '' }), null);
});

test('extractAssistantText keeps text and thinking blocks only', () => {
  assert.equal(
    extractAssistantText([
      { type: 'thinking', thinking: '思考' },
      { type: 'text', text: '回答' },
      { type: 'tool_use', name: 'read' }
    ]),
    '思考回答'
  );
  assert.equal(extractAssistantText('plain'), 'plain');
});

test('estimated source kinds are explicit and idempotent', () => {
  assert.equal(
    qoderEstimatedSourceKind('server_qoder_cli_proxy'),
    'server_qoder_cli_proxy_estimated'
  );
  assert.equal(
    qoderEstimatedSourceKind('server_qoder_cli_proxy_estimated'),
    'server_qoder_cli_proxy_estimated'
  );
});

test('toOpenAiUsage emits chat completion usage fields', () => {
  assert.deepEqual(
    toOpenAiUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }),
    { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  );
  assert.equal(toOpenAiUsage(null), undefined);
});
