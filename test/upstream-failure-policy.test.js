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

test('retry hints parses AGY Google quotaResetDelay from response body', () => {
  const ms = parseProviderRetryHintMs({
    provider: 'agy',
    body: JSON.stringify({
      error: {
        details: [{
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '12s'
        }]
      }
    })
  });
  assert.equal(ms, 12000);
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
  // 429 is bound to (account, model): cools the model, not the whole account.
  assert.equal(policy.scope, 'model');
});

test('failure policy treats AGY resource exhausted 429 as long model quota cooldown', () => {
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 429,
    detail: 'HTTP 429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'model_quota_exhausted');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.clientStatusCode, 429);
  assert.equal(policy.cooldownMs >= 24 * 60 * 60 * 1000, true);
});

test('failure policy treats Gemini model capacity 429 as model-scoped without account cooldown', () => {
  const policy = classifyUpstreamFailure({
    provider: 'gemini',
    statusCode: 429,
    detail: 'HTTP 429 {"error":{"message":"No capacity available for model gemini-3.1-pro-preview on the server"}}',
    defaultCooldownMs: 1000
  });
  // Model-scoped: cools only this (account, model) tuple; the account stays
  // usable for its other models. shouldMarkFailure is now true so the scheduler
  // actually backs off the exhausted model (and alias fallback can switch).
  assert.equal(policy.kind, 'model_capacity_unavailable');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.clientStatusCode, 429);
  assert.ok(policy.cooldownMs > 0);
});

test('failure policy treats Gemini model quota reset 429 as model-scoped without account cooldown', () => {
  const policy = classifyUpstreamFailure({
    provider: 'gemini',
    statusCode: 429,
    detail: 'HTTP 429 {"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 26s."}}',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'model_capacity_unavailable');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.clientStatusCode, 429);
  assert.ok(policy.cooldownMs > 0);
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

test('failure policy treats selected model capacity 400 as model-scoped retry', () => {
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
  assert.equal(policy.kind, 'model_capacity_unavailable');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
  assert.equal(policy.clientStatusCode, 503);
});

test('failure policy treats Google unsupported location 400 as account failure', () => {
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 400,
    detail: 'HTTP 400 {"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'location_unsupported');
  assert.equal(policy.scope, 'account');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
  assert.equal(policy.failureReason, 'location_unsupported');
  assert.equal(policy.clientStatusCode, 503);
  assert.equal(policy.cooldownMs >= 24 * 60 * 60 * 1000, true);
});

test('failure policy treats selected model capacity error text as model-scoped retry', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    error: new Error('Selected model is at capacity. Please try a different model.'),
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'model_capacity_unavailable');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
});

test('failure policy treats stream disconnected before completion as model-scoped retry', () => {
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
  // Server-side, request-specific: cool only this (account, model), never the
  // whole account, so the account's other models stay routable.
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 30000);
});

test('failure policy treats upstream 503 as model-scoped so the account keeps serving other models', () => {
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 503,
    detail: 'service unavailable',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'service_unavailable');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.clientStatusCode, 503);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.shouldPassthroughToClient, false);
});

test('failure policy treats 529 overload as model-scoped so the account keeps serving other models', () => {
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 529,
    detail: 'overloaded',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'overloaded');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.clientStatusCode, 529);
  assert.equal(policy.shouldRetryAnotherAccount, true);
});

test('failure policy treats generic upstream 5xx as model-scoped retry', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 500,
    detail: 'internal server error',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'upstream_server_error');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.clientStatusCode, 500);
  assert.equal(policy.shouldRetryAnotherAccount, true);
});

test('failure policy treats empty upstream model responses as model-scoped retry without account cooldown', () => {
  const err = new Error('empty_upstream_response');
  err.code = 'EMPTY_UPSTREAM_RESPONSE';
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    error: err,
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'empty_model_response');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.cooldownMs, 0);
  assert.equal(policy.clientStatusCode, 502);
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

test('failure policy gives transient network blips a consecutive-failure threshold and a short cooldown', () => {
  const err = new Error('fetch failed');
  err.code = 'UND_ERR_SOCKET';
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    error: err,
    // Even with a large configured default, a single network blip must not earn
    // a long cooldown; it should self-heal in seconds. Model-scoped so a blip on
    // one model never blocks the account's other models.
    defaultCooldownMs: 5 * 60 * 1000
  });
  assert.equal(policy.kind, 'network_error');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 30000);
  assert.equal(policy.shouldRetryAnotherAccount, true);
});

test('failure policy treats undici socket termination as transient network failure', () => {
  const err = new Error('terminated [UND_ERR_SOCKET]');
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    error: err,
    defaultCooldownMs: 5 * 60 * 1000
  });
  assert.equal(policy.kind, 'network_error');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 30000);
  assert.equal(policy.shouldRetryAnotherAccount, true);
});

test('failure policy gives transient timeouts the same threshold and short cooldown as network errors', () => {
  const err = new Error('request timeout');
  err.code = 'UND_ERR_CONNECT_TIMEOUT';
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    error: err,
    defaultCooldownMs: 5 * 60 * 1000
  });
  assert.equal(policy.kind, 'timeout');
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 30000);
});

test('failure policy treats AbortError as transient timeout instead of account poison', () => {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  err.code = 20;
  const policy = classifyUpstreamFailure({
    provider: 'opencode',
    error: err,
    defaultCooldownMs: 5 * 60 * 1000
  });
  assert.equal(policy.kind, 'timeout');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 30000);
  assert.equal(policy.shouldRetryAnotherAccount, true);
});
