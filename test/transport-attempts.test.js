'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MAX_ATTEMPTS,
  recordTransportAttempt,
  listTransportAttempts
} = require('../lib/server/transport-attempts');
const { withAttemptAnnotations } = require('../lib/server/attempt-annotations');

test('recordTransportAttempt appends the same shape for every transport', () => {
  const attempt = {};
  recordTransportAttempt(attempt, {
    transport: 'qoder_http',
    outcome: 'success',
    durationMs: 930,
    upstream: 'https://gateway.qoder.com.cn',
    provider: 'qodercn',
    accountRef: 'acct-1',
    model: 'Qwen3.8-Flash',
    stream: false,
    firstTokenMs: 527,
    usage: {
      source: 'exact',
      promptTokens: 26,
      completionTokens: 1,
      totalTokens: 27,
      cachedTokens: 0,
      reasoningTokens: 0,
      credits: 0,
      billable: false
    },
    details: {
      endpointSource: 'endpoint_cache',
      egress: 'proxy',
      serverDurationMs: 12.4,
      nested: { should: 'be dropped' },
      empty: ''
    }
  });
  recordTransportAttempt(attempt, {
    transport: 'qoder_cli',
    outcome: 'failure',
    durationMs: 7875,
    upstream: 'qoder-cli',
    provider: 'qodercn',
    accountRef: 'acct-1',
    model: 'Qwen3.8-Flash',
    stream: true,
    errorCode: 'qoder_cli_timeout',
    usage: { source: 'estimated', promptTokens: 3272, completionTokens: 12, totalTokens: 3284 },
    details: { warm: false, warmReused: false, statusCode: 502 }
  });

  const attempts = listTransportAttempts(attempt);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    Object.keys(attempts[0]).sort(),
    ['accountRef', 'details', 'durationMs', 'firstTokenMs', 'model', 'outcome', 'provider', 'stream', 'transport', 'upstream', 'usage'].sort()
  );
  assert.equal(attempts[0].transport, 'qoder_http');
  assert.equal(attempts[0].durationMs, 930);
  assert.equal(attempts[0].usage.source, 'exact');
  assert.equal(attempts[0].usage.totalTokens, 27);
  assert.equal(attempts[0].usage.cachedTokens, 0);
  assert.equal(attempts[0].details.serverDurationMs, 12.4);
  assert.equal(attempts[0].details.nested, undefined);
  assert.equal(attempts[0].details.empty, undefined);

  assert.equal(attempts[1].transport, 'qoder_cli');
  assert.equal(attempts[1].outcome, 'failure');
  assert.equal(attempts[1].durationMs, 7875);
  assert.equal(attempts[1].errorCode, 'qoder_cli_timeout');
  assert.equal(attempts[1].usage.source, 'estimated');
  assert.equal(attempts[1].details.statusCode, 502);

  // 日志出口自动带上统一的 attempt 数组。
  const logEntry = withAttemptAnnotations({ requestId: 'r-1', durationMs: 9000 }, attempt);
  assert.equal(logEntry.transportAttempts.length, 2);
  assert.equal(logEntry.transportAttempts[0].transport, 'qoder_http');
});

test('recordTransportAttempt drops invalid entries and never throws', () => {
  const attempt = {};
  assert.equal(recordTransportAttempt(attempt, null), null);
  assert.equal(recordTransportAttempt(attempt, { outcome: 'success', durationMs: 1 }), null);
  assert.equal(recordTransportAttempt(attempt, { transport: 'qoder_http', outcome: 'unknown' }), null);
  assert.equal(recordTransportAttempt(null, { transport: 'qoder_http', outcome: 'success' }), null);
  assert.equal(listTransportAttempts(attempt).length, 0);
});

test('recordTransportAttempt caps the per-request attempt list', () => {
  const attempt = {};
  for (let index = 0; index < MAX_ATTEMPTS + 3; index += 1) {
    recordTransportAttempt(attempt, {
      transport: 'qoder_http',
      outcome: 'failure',
      durationMs: index,
      errorCode: `retry_${index}`
    });
  }
  const attempts = listTransportAttempts(attempt);
  assert.equal(attempts.length, MAX_ATTEMPTS);
  assert.equal(attempts[0].errorCode, 'retry_3', 'oldest attempts must be evicted first');
  assert.equal(attempts[attempts.length - 1].errorCode, `retry_${MAX_ATTEMPTS + 2}`);
});
