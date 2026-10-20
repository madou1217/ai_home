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
  resolveQoderUsage,
  summarizeQoderUsage,
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

test('resolveQoderUsage prefers real token counters over estimation', () => {
  const resolved = resolveQoderUsage({
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      context_usage_ratio: 0.5,
      credits: 1
    },
    outputText: 'hello world'
  });
  assert.equal(resolved.inputTokens, 10);
  assert.equal(resolved.outputTokens, 5);
  assert.equal(resolved.totalTokens, 15);
  assert.equal(resolved.contextUsageRatio, 0.5);
  assert.equal(resolved.credits, 1);
  assert.equal(resolved.estimated, false);
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


test('summarizeQoderUsage produces the unified attempt usage shape', () => {
  const exact = summarizeQoderUsage({
    prompt_tokens: 26,
    completion_tokens: 1,
    total_tokens: 27,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 1 },
    credits: 0,
    original_credits: 0,
    billable: false
  });
  assert.deepEqual(exact, {
    source: 'exact',
    promptTokens: 26,
    completionTokens: 1,
    totalTokens: 27,
    cachedTokens: 20,
    reasoningTokens: 1,
    credits: 0,
    originalCredits: 0,
    billable: false
  });

  const estimated = summarizeQoderUsage(
    { prompt_tokens: 3272, completion_tokens: 12, total_tokens: 3284 },
    { estimated: true }
  );
  assert.equal(estimated.source, 'estimated');
  assert.equal(estimated.promptTokens, 3272);
  assert.equal(estimated.completionTokens, 12);
  assert.equal(estimated.totalTokens, 3284);
  assert.equal(estimated.credits, undefined, 'no billing evidence must not be reported as zero credits');
});

test('summarizeQoderUsage returns null without token counters', () => {
  assert.equal(summarizeQoderUsage(null), null);
  assert.equal(summarizeQoderUsage({ input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(summarizeQoderUsage({ prompt_tokens: 0, completion_tokens: 0 }), null);
});
