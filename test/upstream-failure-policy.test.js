const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProviderRetryHintMs } = require('../lib/server/retry-hints');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

test('retry hints parses Retry-After seconds header', () => {
  const ms = parseProviderRetryHintMs({
    provider: 'claude',
    headers: { 'retry-after': '120' },
    nowMs: 1000
  });
  assert.equal(ms, 120000);
});

test('retry hints parses gemini quotaResetDelay from response body', () => {
  const ms = parseProviderRetryHintMs({
    provider: 'gemini',
    body: JSON.stringify({
      error: {
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          metadata: { quotaResetDelay: '373.801628ms' }
        }]
      }
    })
  });
  assert.equal(ms, 374);
});

test('failure policy classifies 429 as immediate rate limit cooldown', () => {
  const policy = classifyUpstreamFailure({
    provider: 'gemini',
    statusCode: 429,
    headers: { 'retry-after': '60' },
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'rate_limited');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.failureThreshold, 1);
  assert.equal(policy.cooldownMs, 60000);
});

test('failure policy keeps 404 as passthrough request error without account penalty', () => {
  const policy = classifyUpstreamFailure({
    provider: 'claude',
    statusCode: 404,
    detail: 'upstream_404: model not found'
  });
  assert.equal(policy.kind, 'not_found');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.shouldPassthroughToClient, true);
  assert.equal(policy.shouldRetryAnotherAccount, false);
  assert.equal(policy.clientStatusCode, 404);
});

test('failure policy treats codex deactivated workspace as account auth failure', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 402,
    body: JSON.stringify({ detail: { code: 'deactivated_workspace' } }),
    detail: 'upstream_402',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
  assert.equal(policy.failureReason, 'deactivated_workspace');
});

test('failure policy treats 401 as reauth-required account failure', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 401,
    detail: 'upstream_401_account_10025',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.failureReason, 'auth_invalid_reauth_required');
  assert.equal(policy.cooldownMs > 300 * 24 * 60 * 60 * 1000, true);
});

test('failure policy treats model capacity 400 as retryable overload', () => {
  const policy = classifyUpstreamFailure({
    provider: 'claude',
    statusCode: 400,
    body: JSON.stringify({
      error: {
        message: 'Selected model is at capacity. Please try a different model.'
      }
    }),
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'overloaded');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
  assert.equal(policy.clientStatusCode, 503);
});

test('failure policy treats model capacity error text as retryable overload', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    error: new Error('Selected model is at capacity. Please try a different model.'),
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'overloaded');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
});

test('failure policy treats stream disconnected before completion as retryable account failure', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    error: new Error(
      'stream disconnected before completion: An error occurred while processing your request. '
      + 'Please include the request ID 4d251fd0-862a-4b1f-90a3-fb3ed9629f18 in your message.'
    ),
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'service_unavailable');
  assert.equal(policy.failureReason, 'stream_disconnected_before_completion');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
});

test('failure policy classifies timeout errors as retryable transient failures', () => {
  const err = new Error('request timeout');
  err.code = 'ETIMEDOUT';
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    error: err,
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'timeout');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.clientStatusCode, 504);
});
