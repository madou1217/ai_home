'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDiagnosticMessage } = require('../lib/server/chat-runtime/canonical-diagnostic-sanitizer');
const { writeCodexRelayError } = require('../lib/server/codex-relay-errors');

test('diagnostic formatter preserves nested object failures instead of [object Object]', () => {
  assert.equal(
    formatDiagnosticMessage({ error: { message: 'remote pool exhausted', retryAfterSeconds: 30 } }),
    'remote pool exhausted',
  );
  assert.match(formatDiagnosticMessage({ code: 'remote_pool_unavailable', retryAfterSeconds: 30 }), /remote_pool_unavailable/);
});

test('Codex relay error carries an actionable retry window', () => {
  const headers = new Map();
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers.set(name, value); },
    end(body) { this.body = JSON.parse(body); }
  };
  writeCodexRelayError(response, 'remote_pool_unavailable', 503, {
    message: 'The remote Codex account pool is temporarily unavailable. Retry in 30s.',
    detail: 'upstream reported no_available_account',
    retryAfterSeconds: 30
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'remote_pool_unavailable');
  assert.match(response.body.error.message, /Retry in 30s/);
  assert.equal(response.body.error.retry_after_seconds, 30);
  assert.equal(response.body.error.detail, 'upstream reported no_available_account');
});
