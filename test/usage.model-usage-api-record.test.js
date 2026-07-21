'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApiUsageRecord,
  normalizeApiUsageByFormat,
  normalizeApiUsageByProvider,
  __private: {
    inferUsageFormat,
    normalizeAnthropicUsage,
    normalizeGeminiUsage,
    normalizeOpenAiUsage,
    normalizeUsageFormat
  }
} = require('../lib/usage/model-usage-api-record');

test('normalizeUsageFormat maps supported aliases and rejects unknown values', () => {
  assert.equal(normalizeUsageFormat('OpenAI '), 'openai');
  assert.equal(normalizeUsageFormat('openai_chat'), 'openai');
  assert.equal(normalizeUsageFormat('openai_responses'), 'openai');
  assert.equal(normalizeUsageFormat('claude'), 'anthropic');
  assert.equal(normalizeUsageFormat('anthropic'), 'anthropic');
  assert.equal(normalizeUsageFormat('google'), 'gemini');
  assert.equal(normalizeUsageFormat('gemini'), 'gemini');
  assert.equal(normalizeUsageFormat('unknown'), '');
  assert.equal(normalizeUsageFormat(''), '');
  assert.equal(normalizeUsageFormat(null), '');
});

test('inferUsageFormat detects usage shape before provider fallback', () => {
  assert.equal(inferUsageFormat('codex', { promptTokenCount: 1 }), 'gemini');
  assert.equal(inferUsageFormat('codex', { prompt_token_count: 1 }), 'gemini');
  assert.equal(inferUsageFormat('codex', { prompt_tokens: 1 }), 'openai');
  assert.equal(inferUsageFormat('codex', { prompt_tokens_details: { cached_tokens: 1 } }), 'openai');
  assert.equal(inferUsageFormat('claude', { cache_read_input_tokens: 1 }), 'anthropic');
  assert.equal(inferUsageFormat('claude', { input_tokens: 1, output_tokens: 2 }), 'anthropic');
  assert.equal(inferUsageFormat('codex', { input_tokens: 1, output_tokens: 2 }), 'openai');
  assert.equal(inferUsageFormat('gemini', { input_tokens: 1, output_tokens: 2 }), 'openai');
  assert.equal(inferUsageFormat('codex', {}), '');
  assert.equal(inferUsageFormat('codex', null), '');
  assert.equal(inferUsageFormat('codex', 'usage'), '');
  assert.equal(inferUsageFormat('claude', { promptTokenCount: 1, prompt_tokens: 2 }), 'gemini');
});

test('normalizeOpenAiUsage handles cache deduction, aliases, fallback totals, and invalid numbers', () => {
  assert.deepEqual(normalizeOpenAiUsage({
    prompt_tokens: 100,
    completion_tokens: 25,
    prompt_tokens_details: { cached_tokens: 30 }
  }), {
    inputTokens: 70,
    outputTokens: 25,
    cacheReadInputTokens: 30,
    totalTokens: 125
  });

  assert.deepEqual(normalizeOpenAiUsage({
    input_tokens: 42,
    output_tokens: 8,
    input_tokens_details: { cached_input_tokens: 12 }
  }), {
    inputTokens: 30,
    outputTokens: 8,
    cacheReadInputTokens: 12,
    totalTokens: 50
  });

  assert.deepEqual(normalizeOpenAiUsage({
    prompt_tokens: -10,
    completion_tokens: 'not-a-number',
    total_tokens: NaN,
    prompt_tokens_details: { cached_tokens: -5 }
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0
  });
});

test('normalizeAnthropicUsage maps all token fields and totals cache tokens', () => {
  assert.deepEqual(normalizeAnthropicUsage({
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 2
  }), {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 2,
    totalTokens: 20
  });
});

test('normalizeGeminiUsage handles camelCase, snake_case, cache deduction, and thoughts', () => {
  assert.deepEqual(normalizeGeminiUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 7,
    cachedContentTokenCount: 30
  }), {
    inputTokens: 70,
    outputTokens: 20,
    cacheReadInputTokens: 30,
    reasoningOutputTokens: 7,
    totalTokens: 127
  });

  assert.deepEqual(normalizeGeminiUsage({
    prompt_token_count: 10,
    candidates_token_count: 4,
    thoughts_token_count: 3,
    cached_content_token_count: 12,
    total_token_count: 17
  }), {
    inputTokens: 0,
    outputTokens: 4,
    cacheReadInputTokens: 12,
    reasoningOutputTokens: 3,
    totalTokens: 17
  });
});

test('normalizeApiUsageByProvider rejects invalid usage and prefers inferred usage shape', () => {
  assert.equal(normalizeApiUsageByProvider('codex', null), null);
  assert.equal(normalizeApiUsageByProvider('codex', 'usage'), null);

  assert.deepEqual(normalizeApiUsageByProvider('claude', {
    promptTokenCount: 12,
    cachedContentTokenCount: 3,
    candidatesTokenCount: 4
  }), {
    inputTokens: 9,
    outputTokens: 4,
    cacheReadInputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 16
  });
});

test('normalizeApiUsageByProvider falls back to provider defaults when shape is unknown', () => {
  assert.deepEqual(normalizeApiUsageByProvider('claude', {}), {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0
  });
  assert.deepEqual(normalizeApiUsageByProvider('gemini', {}), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
  assert.deepEqual(normalizeApiUsageByProvider('agy', {}), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
  assert.deepEqual(normalizeApiUsageByProvider('codex', {}), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0
  });
});

test('normalizeApiUsageByFormat lets explicit format override inference', () => {
  assert.deepEqual(normalizeApiUsageByFormat('anthropic', 'codex', {
    prompt_tokens: 100,
    completion_tokens: 20,
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 2
  }), {
    inputTokens: 7,
    outputTokens: 3,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2,
    totalTokens: 12
  });
});

test('normalizeApiUsageByFormat falls back to provider normalization for invalid format', () => {
  const usage = { input_tokens: 6, output_tokens: 2 };

  assert.deepEqual(
    normalizeApiUsageByFormat('invalid', 'claude', usage),
    normalizeApiUsageByProvider('claude', usage)
  );
});

test('buildApiUsageRecord returns normalized record with trimmed metadata', () => {
  const record = buildApiUsageRecord({
    provider: ' Codex ',
    model: ' gpt-5-codex ',
    requestId: ' req_1 ',
    accountRef: ' acct_0123456789abcdef0123 ',
    sessionId: ' session-1 ',
    project: ' project-a ',
    cwd: ' /work/project-a ',
    timestampMs: 1770000000000,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 30 }
    }
  });

  assert.deepEqual({
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    totalTokens: record.totalTokens,
    provider: record.provider,
    model: record.model,
    requestId: record.requestId,
    accountRef: record.accountRef,
    sessionId: record.sessionId,
    project: record.project,
    cwd: record.cwd,
    sourceKind: record.sourceKind,
    timestampMs: record.timestampMs
  }, {
    inputTokens: 70,
    outputTokens: 25,
    cacheReadInputTokens: 30,
    totalTokens: 125,
    provider: 'codex',
    model: 'gpt-5-codex',
    requestId: 'req_1',
    accountRef: 'acct_0123456789abcdef0123',
    sessionId: 'session-1',
    project: 'project-a',
    cwd: '/work/project-a',
    sourceKind: 'server_api',
    timestampMs: 1770000000000
  });
});

test('buildApiUsageRecord accepts only accountRef as its account key', () => {
  const input = {
    provider: 'codex',
    usage: { prompt_tokens: 1 }
  };

  assert.throws(
    () => buildApiUsageRecord({ ...input, accountRef: '1' }),
    /model_usage_account_ref_invalid/
  );
  ['accountId', 'account_id', 'account_ref'].forEach((field) => {
    assert.throws(
      () => buildApiUsageRecord({ ...input, [field]: '1' }),
      /model_usage_account_key_invalid/
    );
  });
});

test('buildApiUsageRecord returns null without provider, usage, or non-zero tokens', () => {
  assert.equal(buildApiUsageRecord({
    model: 'gpt-5-codex',
    usage: { prompt_tokens: 1 }
  }), null);
  assert.equal(buildApiUsageRecord({
    provider: 'codex'
  }), null);
  assert.equal(buildApiUsageRecord({
    provider: 'codex',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }), null);
});

test('buildApiUsageRecord preserves explicit eventKey', () => {
  const record = buildApiUsageRecord({
    provider: 'codex',
    eventKey: 'custom:event-key',
    usage: { prompt_tokens: 1 }
  });

  assert.equal(record.eventKey, 'custom:event-key');
});

test('buildApiUsageRecord generates deterministic event keys with usage hash suffix', () => {
  const input = {
    provider: ' Codex ',
    accountRef: ' acct_0123456789abcdef0123 ',
    requestId: ' request-1 ',
    model: ' gpt-5-codex ',
    timestampMs: 1770000000000,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5
    }
  };

  const first = buildApiUsageRecord(input);
  const second = buildApiUsageRecord(input);
  const changed = buildApiUsageRecord({
    ...input,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 6
    }
  });

  assert.match(first.eventKey, /^api:codex:request-1:acct_0123456789abcdef0123:1770000000000:[0-9a-f]{16}$/);
  assert.equal(first.eventKey, second.eventKey);
  assert.notEqual(first.eventKey, changed.eventKey);
});

test('buildApiUsageRecord uses current time when timestampMs is omitted', () => {
  const before = Date.now();
  const record = buildApiUsageRecord({
    provider: 'codex',
    usage: { prompt_tokens: 1 }
  });
  const after = Date.now();

  assert.equal(typeof record.timestampMs, 'number');
  assert.ok(record.timestampMs >= before);
  assert.ok(record.timestampMs <= after);
});
