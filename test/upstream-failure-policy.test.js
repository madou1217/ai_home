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

test('failure policy treats AGY resource exhausted 429 as short model rate-limit cooldown', () => {
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 429,
    detail: 'HTTP 429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'rate_limited');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.shouldMarkFailure, true);
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.clientStatusCode, 429);
  // agy/gemini RESOURCE_EXHAUSTED without a retryDelay hint is a transient
  // rate limit, not a true 24h quota block. Cooldown must be short (5 min).
  assert.equal(policy.cooldownMs, 5 * 60 * 1000);
});

test('failure policy treats AGY resource exhausted 429 with retryDelay as provider-hinted cooldown', () => {
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 429,
    detail: 'HTTP 429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
    body: {
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '30s'
        }]
      }
    },
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'model_quota_exhausted');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.cooldownMs, 30000);
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
  assert.equal(policy.deferAccountFailureUntilRequestOutcome, true);
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

test('failure policy treats a subscription-locked model 403 as model-scoped, not account auth failure', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 403,
    body: JSON.stringify({
      error: {
        message: 'this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: 7563e0c3)',
        type: 'api_error'
      }
    }),
    detail: 'upstream_403_account_acct_52facbdf93d7161b990d',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'model_entitlement_required');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.failureReason, 'model_requires_subscription');
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.equal(policy.clientStatusCode, 403);
  // A day, not the auth_invalid year: entitlement changes when the plan does.
  assert.equal(policy.cooldownMs, 24 * 60 * 60 * 1000);
});

test('failure policy still treats an ordinary 403 as an account-scoped auth failure', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 403,
    body: JSON.stringify({ error: { message: 'invalid api key' } }),
    detail: 'upstream_403_account_10025',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(policy.scope, 'account');
  assert.equal(policy.failureReason, 'auth_invalid_reauth_required');
});

test('failure policy keeps OpenCode RegionError model-scoped instead of marking auth invalid', () => {
  const policy = classifyUpstreamFailure({
    provider: 'opencode',
    statusCode: 403,
    body: JSON.stringify({
      type: 'error',
      error: {
        type: 'RegionError',
        message: 'The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai/workspace/wrk/go'
      }
    }),
    detail: 'HTTP 403 RegionError',
    defaultCooldownMs: 1000
  });
  assert.equal(policy.kind, 'model_region_restricted');
  assert.equal(policy.scope, 'model');
  assert.equal(policy.failureReason, 'model_region_restricted');
  assert.equal(policy.shouldRetryAnotherAccount, true);
  assert.notEqual(policy.failureReason, 'auth_invalid_reauth_required');
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

test('failure policy treats a structured sensitive-words code as request-scoped safety rejection', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 500,
    body: JSON.stringify({
      error: {
        message: 'sensitive words detected',
        type: 'new_api_error',
        code: 'sensitive_words_detected'
      }
    }),
    detail: 'upstream_500'
  });

  assert.equal(policy.kind, 'safety_rejected');
  assert.equal(policy.scope, 'none');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.shouldRetryAnotherAccount, false);
  assert.equal(policy.shouldPassthroughToClient, false);
  assert.equal(policy.clientStatusCode, 403);
  assert.equal(policy.detail, 'upstream_safety_rejected');
});

test('failure policy never infers safety rejection from free-form message text', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 500,
    body: JSON.stringify({
      error: {
        message: 'a diagnostic mentioned sensitive_words_detected',
        type: 'server_error',
        code: 'upstream_failure'
      }
    }),
    detail: 'upstream_500'
  });

  assert.equal(policy.kind, 'upstream_server_error');
  assert.equal(policy.shouldRetryAnotherAccount, true);
});

test('failure policy recognizes a structured safety code inside a successful SSE failure envelope', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 0,
    body: {
      type: 'response.failed',
      response: {
        error: {
          message: 'sensitive words detected',
          code: 'sensitive_words_detected'
        }
      }
    },
    detail: 'structured response failure'
  });

  assert.equal(policy.kind, 'safety_rejected');
  assert.equal(policy.scope, 'none');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.shouldRetryAnotherAccount, false);
  assert.equal(policy.clientStatusCode, 403);
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

test('failure policy retries transport errors without poisoning account schedulability', () => {
  const err = new Error('fetch failed');
  err.code = 'UND_ERR_SOCKET';
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    error: err,
    defaultCooldownMs: 5 * 60 * 1000
  });
  assert.equal(policy.kind, 'network_error');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 0);
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
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.failureThreshold, 2);
  assert.equal(policy.cooldownMs, 0);
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

// 中转账号/官方账号都会用 400/404 说「我这儿没有这个模型」。这类错误绑在
// (账号, 模型) 上：换个账号很可能就能服务，所以必须换号重试并冷却这对组合，
// 而不是把 400 直接甩给客户端（用户看到的就是那条 Invalid model name）。
const MODEL_MISSING_DETAILS = [
  ['litellm 中转', 400, '/responses: Invalid model name passed in model=gpt-5.6-luna. Call `/v1/models` to view available models for your key.'],
  ['new-api 中转', 404, '{"error":{"message":"Model \\"gpt-5.6-luna\\" is not supported by any configured account in this group","type":"model_not_found"}}'],
  ['官方 ChatGPT 账号', 400, "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."],
  ['OpenAI 经典文案', 404, 'The model `gpt-9` does not exist or you do not have access to it.']
];

MODEL_MISSING_DETAILS.forEach(([label, statusCode, detail]) => {
  test(`模型不在该端点上(${label}) 换账号重试而不是甩 4xx 给客户端`, () => {
    const policy = classifyUpstreamFailure({
      provider: 'codex',
      statusCode,
      body: detail,
      detail,
      defaultCooldownMs: 60000
    });
    assert.equal(policy.kind, 'model_not_available_on_endpoint');
    assert.equal(policy.shouldRetryAnotherAccount, true);
    assert.equal(policy.shouldPassthroughToClient, false);
    // 只冷却这一对 (账号, 模型)，账号本身还要继续服务它支持的模型
    assert.equal(policy.scope, 'model');
    assert.equal(policy.cooldownMs, 30 * 60 * 1000);
  });
});

test('普通 400 参数错误仍然直接回客户端，不换账号空跑', () => {
  const detail = "Missing required parameter: 'input'.";
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 400,
    body: detail,
    detail,
    defaultCooldownMs: 60000
  });
  assert.equal(policy.kind, 'invalid_request');
  assert.equal(policy.shouldPassthroughToClient, true);
  assert.equal(policy.shouldRetryAnotherAccount, false);
});
