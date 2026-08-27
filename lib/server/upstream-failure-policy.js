'use strict';

const { parseProviderRetryHintMs } = require('./retry-hints');
const { ZCODE_QUOTA_BUSINESS_CODE } = require('./zcode-business-error');

const DEFAULT_AUTH_INVALID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_SERVER_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
// Transient connectivity blips (fetch failed / socket reset / timeout) are
// almost always client/proxy-side and self-heal in seconds. They must NOT pull
// a healthy account out of the pool on a single occurrence; that lets one
// shared-proxy hiccup empty the whole pool and surface as no_available_account.
// So: require several consecutive failures before cooling, and keep the cooldown
// short so the account re-probes quickly once connectivity returns.
const DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS = 30 * 1000;
const TRANSIENT_NETWORK_FAILURE_THRESHOLD = 2;
const DEFAULT_UNSUPPORTED_LOCATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Plan entitlement is a durable state that only changes when the operator
// upgrades, so re-probing every few minutes is pointless — but it is not
// permanent either, hence a day rather than the auth_invalid year.
const DEFAULT_MODEL_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_REGION_RESTRICTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// A monthly usage cap (e.g. opencode GoUsageLimitError "resets in N days") blocks
// the whole workspace/account until reset, so cool the ACCOUNT (all its models),
// not just one (account, model). Floor 24h, cap 30d if the reset hint is huge.
const DEFAULT_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
// 「这个端点没有这个模型」是相对稳定的事实，但中转商随时可能上新模型，
// 所以冷却半小时——足够避免每次请求都去撞同一批不支持的账号，又不至于
// 让新上线的模型半天发现不了。
const DEFAULT_MODEL_NOT_ON_ENDPOINT_COOLDOWN_MS = 30 * 60 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function collectFailureText(options = {}) {
  return [
    options.detail,
    options.body,
    describeError(options.error)
  ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join('\n');
}

const SAFETY_REJECTION_CODES = new Set([
  'content_policy_violation',
  'safety_rejected',
  'sensitive_words_detected'
]);

function parseStructuredFailureBody(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : normalizeText(value);
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function extractStructuredFailureCode(options = {}) {
  const body = parseStructuredFailureBody(options.body);
  const candidates = [
    body && body.error && body.error.code,
    body && body.response && body.response.error && body.response.error.code,
    body && body.last_error && body.last_error.code,
    body && body.response && body.response.last_error && body.response.last_error.code,
    body && body.code,
    body && body.detail && body.detail.code,
    options.error && options.error.code
  ];
  for (const candidate of candidates) {
    const code = normalizeText(candidate).toLowerCase();
    if (code) return code;
  }
  return '';
}

function isStructuredSafetyRejection(options = {}) {
  return SAFETY_REJECTION_CODES.has(extractStructuredFailureCode(options));
}

function buildSafetyRejectedPolicy() {
  return {
    kind: 'safety_rejected',
    retryable: false,
    shouldMarkFailure: false,
    // Safety decisions are request-scoped. Rotating credentials here would
    // both misdiagnose account health and turn routing into policy evasion.
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 403,
    failureReason: 'safety_rejected',
    detail: 'upstream_safety_rejected',
    scope: 'none',
    shouldUnbindSession: false
  };
}

function isCapacityOverloadDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('selected model is at capacity. please try a different model.')
    || detail.includes('selected model is at capacity');
}

function isModelCapacityUnavailableDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('no capacity available for model');
}

function isAccountModelQuotaExhaustedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('exhausted your capacity on this model');
}

function isProviderQuotaExhaustedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('resource has been exhausted')
    || detail.includes('quota exhausted')
    || detail.includes('quota exceeded')
    || (detail.includes('resource_exhausted') && (detail.includes('quota') || detail.includes('check quota')));
}

// zcode（智谱/Z.ai）用 HTTP 200 + {"code":1005,"msg":"exceed quota limit"} 表达
// 配额拒绝，状态码永远是 200，因此必须按结构化业务码判定、与传输层状态无关。
// 只认 code，不匹配 msg 文案：同一份 detail 里 "exceed quota limit" 与
// isProviderQuotaExhaustedDetail 的 "quota exceeded" 词序不同，靠文案匹配既漏判
// 又容易误伤别的 provider。
function isZcodeQuotaBusinessRejection(options = {}) {
  if (normalizeText(options.provider).toLowerCase() !== 'zcode') return false;
  return extractStructuredFailureCode(options) === String(ZCODE_QUOTA_BUSINESS_CODE);
}

// A hard, workspace-wide usage cap (not a transient rate limit): opencode-go
// returns `GoUsageLimitError` / "Monthly usage limit reached. Resets in N days".
// It must NOT be treated as a 5-minute rate limit that last-resort keeps re-hitting.
function isProviderUsageLimitReachedDetail(options = {}) {
  const detail = collectFailureText(options);
  // Both markers are opencode-specific (GoUsageLimitError is its error class;
  // "monthly usage limit" is its wording). Kept narrow on purpose: this runs in
  // the shared classifier, so a looser substring like "usage limit reached"
  // would mis-scope an unrelated provider's 429 into a 24h account-wide cooldown.
  return detail.includes('gousagelimiterror')
    || detail.includes('monthly usage limit');
}

// Parse a reset hint like "resets in 13 days" / "resets in 5 hours" into ms.
// Returns 0 when no hint is present so the caller can fall back to a default.
function parseUsageLimitResetCooldownMs(detail) {
  const match = /resets?\s+in\s+(\d+)\s*(day|hour|minute|min)s?/i.exec(String(detail || ''));
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2].toLowerCase();
  const unitMs = unit === 'day' ? 86400000 : unit === 'hour' ? 3600000 : 60000;
  return Math.min(amount * unitMs, MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS);
}

function isStreamDisconnectedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('stream disconnected before completion');
}

// A relay can accept the credential and still refuse ONE model because the
// plan does not include it (ollama cloud answers 403 "this model requires a
// subscription, upgrade for access"). The credential is valid, so classifying
// it as auth_invalid would cool the entire account for a year — and take the
// account's entitled models down with it — over a model the caller merely is
// not subscribed to. Markers stay narrow: both are entitlement wording, never
// emitted for an actually rejected credential.
function isModelEntitlementDeniedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('requires a subscription')
    || detail.includes('upgrade for access');
}

function isOpenCodeFreeUsageLimitDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('freeusagelimiterror')
    || detail.includes('free usage limit reached')
    || detail.includes('free model rate limit');
}

function isOpenCodeCreditsErrorDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('creditserror')
    || detail.includes('opencode.ai/workspace/wrk_')
    || (detail.includes('credits') && detail.includes('add credits'));
}

function isOpenCodeModelRegionRestrictedDetail(options = {}) {
  if (normalizeText(options.provider).toLowerCase() !== 'opencode') return false;
  const detail = collectFailureText(options);
  return detail.includes('regionerror')
    && (detail.includes('only available hosted in china')
      || detail.includes('requires explicit opt in'));
}

// 「这个账号/端点根本没有这个模型」——中转商、官方 ChatGPT 账号都会以 400/404 这样答。
// 与 invalid_request 的区别：错误是绑在 (账号, 模型) 上的，换个账号很可能就能服务，
// 所以必须换号重试并给这对组合打冷却，而不是把 400 直接甩给客户端。
function isModelNotAvailableOnEndpointDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('invalid model name')
    || detail.includes('model_not_found')
    || detail.includes('is not supported by any configured account')
    || detail.includes('unknown provider for model')
    || detail.includes('is not supported when using codex with a chatgpt account')
    || /the model .* does not exist/.test(detail)
    || (detail.includes('model') && detail.includes('does not exist or you do not have access'));
}

function buildModelNotAvailableOnEndpointPolicy(detail, clientStatusCode) {
  return {
    kind: 'model_not_available_on_endpoint',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: DEFAULT_MODEL_NOT_ON_ENDPOINT_COOLDOWN_MS,
    clientStatusCode,
    failureReason: 'model_not_available_on_endpoint',
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

function isDeactivatedWorkspaceDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('deactivated_workspace');
}

function isUnsupportedLocationDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('user location is not supported for the api use')
    || (detail.includes('failed_precondition') && detail.includes('location is not supported'));
}

function buildOverloadPolicy(detail, defaultCooldownMs, clientStatusCode = 503) {
  return {
    kind: 'overloaded',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS),
    clientStatusCode,
    failureReason: detail,
    detail,
    scope: 'account',
    shouldUnbindSession: false
  };
}

function buildModelCapacityPolicy(detail, clientStatusCode = 429, options = {}) {
  return {
    kind: 'model_capacity_unavailable',
    retryable: true,
    // Cool ONLY this (account, model) tuple so the scheduler stops hammering an
    // exhausted model but keeps the account's other models in rotation, and so
    // alias fallback can switch to a different model once all accounts for this
    // one are cooling down.
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: options.shouldRetryAnotherAccount !== false,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(options.cooldownMs) || DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS),
    clientStatusCode,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

function buildModelQuotaExhaustedPolicy(detail, clientStatusCode = 429, options = {}) {
  return {
    kind: 'model_quota_exhausted',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: options.shouldRetryAnotherAccount !== false,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(options.cooldownMs) || DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS),
    clientStatusCode,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

function buildRateLimitedPolicy(detail, cooldownMs) {
  return {
    kind: 'rate_limited',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(cooldownMs) || DEFAULT_RATE_LIMIT_COOLDOWN_MS),
    clientStatusCode: 429,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

// Model-scope entitlement refusal: cool only this (account, model) so the
// account keeps serving the models its plan does include, and alias fallback can
// move on. Not `auth_invalid` — the credential is fine, so no re-login is
// triggered and the account stays schedulable.
function buildModelEntitlementDeniedPolicy(detail, clientStatusCode = 403, options = {}) {
  return {
    kind: 'model_entitlement_required',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: options.shouldRetryAnotherAccount !== false,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(options.cooldownMs) || DEFAULT_MODEL_ENTITLEMENT_COOLDOWN_MS),
    clientStatusCode,
    failureReason: 'model_requires_subscription',
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

function buildModelRegionRestrictedPolicy(detail, clientStatusCode = 403) {
  return {
    kind: 'model_region_restricted',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: DEFAULT_MODEL_REGION_RESTRICTION_COOLDOWN_MS,
    clientStatusCode,
    failureReason: 'model_region_restricted',
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

// Account-scope hard exhaustion: cool the whole account for the reset window so
// account-selector skips it even under the last-resort override (which only
// bypasses the SOFT per-model cooldown), and alias fallback moves to the next
// provider immediately instead of burning retries re-hitting the exhausted one.
// Not `auth_invalid` — the credential is fine, so no re-login is triggered.
function buildAccountUsageExhaustedPolicy(detail, cooldownMs) {
  return {
    kind: 'account_usage_exhausted',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.min(
      MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS,
      Math.max(DEFAULT_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS, Number(cooldownMs) || 0)
    ),
    clientStatusCode: 429,
    failureReason: 'account_usage_limit_reached',
    detail,
    scope: 'account',
    shouldUnbindSession: true
  };
}

function buildStreamDisconnectedPolicy(detail, defaultCooldownMs) {
  return {
    kind: 'service_unavailable',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    // A single interrupted stream is a transport blip, not evidence that this
    // (account, model) is unavailable. Match network/timeout semantics: only a
    // repeated short-window streak earns a brief cooldown.
    failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS,
    clientStatusCode: 503,
    failureReason: 'stream_disconnected_before_completion',
    detail,
    // Server/transport-side, not a credential problem: cool only this
    // (account, model) so the account's other models keep serving. Falls back to
    // account scope when the request has no model (see applyAccountFailurePolicy).
    scope: 'model',
    shouldUnbindSession: false
  };
}

function buildUnsupportedLocationPolicy(detail, defaultCooldownMs) {
  return {
    kind: 'location_unsupported',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(defaultCooldownMs, DEFAULT_UNSUPPORTED_LOCATION_COOLDOWN_MS),
    clientStatusCode: 503,
    failureReason: 'location_unsupported',
    detail,
    scope: 'account',
    shouldUnbindSession: true
  };
}

function describeError(error) {
  const message = normalizeText(error && error.message || error || 'unknown_error');
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  );
  if (!code || message.includes(code)) return message;
  return `${message} [${code}]`;
}

function isTimeoutError(error) {
  const message = describeError(error).toLowerCase();
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  return code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || message.includes('timeout');
}

function isAbortError(error) {
  const name = normalizeText(error && error.name).toLowerCase();
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  if (name === 'aborterror' || code === 'ABORT_ERR') return true;
  const message = describeError(error).toLowerCase();
  return message.includes('operation was aborted')
    || message.includes('this operation was aborted');
}

function isNetworkError(error) {
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  if (['ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  const message = describeError(error).toLowerCase();
  return message.includes('fetch failed')
    || message.includes('und_err_socket')
    || message.includes('network socket disconnected')
    || message.includes('secure tls connection');
}

function isEmptyModelResponseError(error) {
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  return code === 'EMPTY_UPSTREAM_RESPONSE';
}

function buildEmptyModelResponsePolicy(detail) {
  return {
    kind: 'empty_model_response',
    retryable: true,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 502,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: false
  };
}

function buildStatusPolicy(options = {}) {
  const provider = normalizeText(options.provider).toLowerCase();
  const statusCode = Number(options.statusCode) || 0;
  const detail = normalizeText(options.detail || describeError(options.error) || `upstream_${statusCode}`);
  const retryHintMs = parseProviderRetryHintMs({
    provider,
    headers: options.headers,
    body: options.body,
    nowMs: options.nowMs
  });
  const defaultCooldownMs = Math.max(1000, Number(options.defaultCooldownMs) || 60000);

  if (statusCode === 429 && isOpenCodeFreeUsageLimitDetail(options)) {
    // OpenCode free models (hy3-free, deepseek-v4-flash-free, etc.) rate limit by egress IP.
    // Never lock the entire account or trigger a 24h account cooldown.
    return {
      ...buildRateLimitedPolicy(detail, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
      scope: 'model',
      shouldRetryAnotherAccount: true
    };
  }

  if (statusCode === 429 && isProviderUsageLimitReachedDetail(options)) {
    return buildAccountUsageExhaustedPolicy(
      detail,
      parseUsageLimitResetCooldownMs(detail) || retryHintMs
    );
  }

  if (statusCode === 429 && isProviderQuotaExhaustedDetail(options)) {
    // agy/gemini uses RESOURCE_EXHAUSTED for both minute-level rate limits and
    // true quota exhaustion. When the response carries no retryDelay hint, this
    // is almost certainly a transient rate limit — not a 24h quota block. Fall
    // back to the standard 5-minute rate-limit cooldown instead of 24h.
    const isTransientAgyRateLimit = (provider === 'agy' || provider === 'gemini') && retryHintMs <= 0;
    if (isTransientAgyRateLimit) {
      return {
        ...buildRateLimitedPolicy(detail, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
        // A generic RESOURCE_EXHAUSTED without a reset hint can describe the
        // current request shape rather than this credential. Delay account
        // bookkeeping until sibling attempts reveal which scope is supported.
        deferAccountFailureUntilRequestOutcome: true
      };
    }
    return buildModelQuotaExhaustedPolicy(detail, 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0
        ? retryHintMs
        : DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS
    });
  }

  if (isAccountModelQuotaExhaustedDetail(options)) {
    // Quota exhausted for this model: cool the model for the full rate window.
    return buildModelCapacityPolicy(detail, statusCode || 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS
    });
  }

  if (isModelCapacityUnavailableDetail(options)) {
    // Server has no capacity for this model right now: short, transient cooldown.
    const policy = buildModelCapacityPolicy(detail, statusCode || 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS
    });
    if ((provider === 'agy' || provider === 'gemini') && retryHintMs <= 0) {
      // Code Assist can report provider-wide instantaneous model capacity as if
      // it belonged to each credential. Defer state mutation until sibling
      // attempts establish whether the failure is account-local or pool-wide.
      policy.deferAccountFailureUntilRequestOutcome = true;
    }
    return policy;
  }

  if (statusCode === 400 && isCapacityOverloadDetail(options)) {
    return buildModelCapacityPolicy(detail, 503, {
      shouldRetryAnotherAccount: true,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS)
    });
  }

  if (statusCode === 400 && isUnsupportedLocationDetail(options)) {
    return buildUnsupportedLocationPolicy(detail, defaultCooldownMs);
  }

  if (isStreamDisconnectedDetail(options)) {
    return buildStreamDisconnectedPolicy(detail, defaultCooldownMs);
  }

  if ((statusCode === 400 || statusCode === 404) && isModelNotAvailableOnEndpointDetail(options)) {
    return buildModelNotAvailableOnEndpointPolicy(detail, statusCode);
  }

  if (statusCode === 400 || statusCode === 404) {
    return {
      kind: statusCode === 400 ? 'invalid_request' : 'not_found',
      retryable: false,
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: false,
      shouldPassthroughToClient: true,
      failureThreshold: 0,
      cooldownMs: 0,
      clientStatusCode: statusCode,
      failureReason: detail,
      detail,
      scope: 'none',
      shouldUnbindSession: false
    };
  }

  if (statusCode === 403 && isOpenCodeModelRegionRestrictedDetail(options)) {
    return buildModelRegionRestrictedPolicy(detail, statusCode);
  }

  if ((statusCode === 401 || statusCode === 403 || statusCode === 402) && (isModelEntitlementDeniedDetail(options) || isOpenCodeCreditsErrorDetail(options))) {
    return buildModelEntitlementDeniedPolicy(detail, statusCode);
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      kind: 'auth_invalid',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_AUTH_INVALID_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: 'auth_invalid_reauth_required',
      detail,
      scope: 'account',
      shouldUnbindSession: true
    };
  }

  if (statusCode === 402 && isDeactivatedWorkspaceDetail(options)) {
    return {
      kind: 'auth_invalid',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_AUTH_INVALID_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: 'deactivated_workspace',
      detail,
      scope: 'account',
      shouldUnbindSession: true
    };
  }

  if (statusCode === 402) {
    // Payment Required: upstream rejects the request because the account has
    // no credits (e.g. grok spending-limit). Credentials are fine and the
    // account itself is healthy, so never mark failure or cool the account;
    // the weighted selector already avoids empty accounts, so retrying
    // another account adds nothing. Surface the upstream error as-is.
    return {
      kind: 'payment_required',
      retryable: false,
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: false,
      shouldPassthroughToClient: true,
      failureThreshold: 0,
      cooldownMs: 0,
      clientStatusCode: 402,
      failureReason: detail,
      detail,
      scope: 'none',
      shouldUnbindSession: false
    };
  }

  if (statusCode === 429) {
    // A 429 is bound to (provider, account, model): the same account's other
    // models often still have quota (e.g. agy claude 429 while gemini-3.5-flash
    // is fine). Cool only this model so the account stays usable elsewhere and
    // alias fallback can switch models.
    return buildRateLimitedPolicy(
      detail,
      retryHintMs > 0 ? retryHintMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS
    );
  }

  if (statusCode === 529) {
    return {
      kind: 'overloaded',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS),
      clientStatusCode: 529,
      failureReason: detail,
      detail,
      // Overload is an upstream/model condition, not a dead account: cool only
      // this (account, model) so other models on the account stay routable.
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  if (statusCode === 503) {
    return {
      kind: 'service_unavailable',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS,
      clientStatusCode: 503,
      failureReason: detail,
      detail,
      // Transient upstream unavailability for this model/request, not a credential
      // failure: cool only (account, model) so siblings keep serving.
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  if (statusCode >= 500) {
    return {
      kind: 'upstream_server_error',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_SERVER_ERROR_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: detail,
      detail,
      // Upstream 5xx for one model rarely means the account is dead — its other
      // models usually still work. Cool only (account, model).
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  return {
    kind: 'unknown_status',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: statusCode || 502,
    failureReason: detail,
    detail,
    scope: 'none',
    shouldUnbindSession: false
  };
}

function buildErrorPolicy(options = {}) {
  const detail = describeError(options.error);
  const defaultCooldownMs = Math.max(1000, Number(options.defaultCooldownMs) || 60000);
  const timeoutError = isTimeoutError(options.error) || isAbortError(options.error);
  const networkError = isNetworkError(options.error);

  if (isEmptyModelResponseError(options.error)) {
    return buildEmptyModelResponsePolicy(detail);
  }

  if (isModelCapacityUnavailableDetail({ ...options, detail })) {
    return buildModelCapacityPolicy(detail, 429);
  }

  if (isCapacityOverloadDetail({ ...options, detail })) {
    return buildModelCapacityPolicy(detail, 503, {
      shouldRetryAnotherAccount: true,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS)
    });
  }

  if (isUnsupportedLocationDetail({ ...options, detail })) {
    return buildUnsupportedLocationPolicy(detail, defaultCooldownMs);
  }

  if (isStreamDisconnectedDetail({ ...options, detail })) {
    return buildStreamDisconnectedPolicy(detail, defaultCooldownMs);
  }

  if (timeoutError) {
    return {
      kind: 'timeout',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      // Require consecutive failures + a short cooldown so a single transient
      // timeout never removes a healthy (account, model) from rotation. Scoped to
      // the model: connectivity/upstream blips are not credential failures, so the
      // account's other models stay routable (falls back to account when no model).
      failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
      cooldownMs: DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS,
      clientStatusCode: 504,
      failureReason: detail,
      detail,
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  if (networkError) {
    return {
      kind: 'network_error',
      retryable: true,
      // A transport refusal describes endpoint/network reachability, not the
      // credential or the requested model. Keep it observable and retryable,
      // but never poison account schedulability with endpoint health.
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
      cooldownMs: 0,
      clientStatusCode: 502,
      failureReason: detail,
      detail,
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  return {
    kind: 'unknown_error',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: defaultCooldownMs,
    clientStatusCode: 502,
    failureReason: detail,
    detail,
    // Unclassified, but not provably account-wide: default to the smaller blast
    // radius (account, model); credential/identity failures are handled above and
    // stay account-scoped. No model context → falls back to account cooling.
    scope: 'model',
    shouldUnbindSession: false
  };
}

function classifyUpstreamFailure(options = {}) {
  // A structured policy decision has request scope regardless of whether the
  // transport used an HTTP error status or a successful SSE envelope carrying
  // response.failed. Never infer this classification from human-readable text.
  if (isStructuredSafetyRejection(options)) {
    return buildSafetyRejectedPolicy();
  }
  // 同理：zcode 的配额拒绝走 200 信封，statusCode 分支永远看不到它。
  if (isZcodeQuotaBusinessRejection(options)) {
    const zcodeQuotaResetHintMs = parseProviderRetryHintMs(options);
    // 只有上游明确给出 reset 提示，才敢认定这是「要等到下个周期」的硬配额。
    if (zcodeQuotaResetHintMs > 0) {
      return buildModelQuotaExhaustedPolicy(normalizeText(options.detail), 429, {
        shouldRetryAnotherAccount: true,
        cooldownMs: zcodeQuotaResetHintMs
      });
    }
    // 没有 reset 提示时不能按 24h 封锁：实测（2026-08-22 requestId b4fc7d4e…）
    // 该账号 billing/balance 仍报 remaining_units=74,081,782/100,000,000 且
    // period=one_time——套餐里根本没有「今日额度」这个桶。也就是说 1005 用的是
    // balance 未暴露的另一维度（速率/并发/单请求），这类通常是瞬时的。
    // 对一个还剩 74% 额度的账号开 24h 冷却等于自伤，沿用 agy/gemini 的同款判断：
    // 退到标准限流冷却，并把账号级记账推迟到本次请求的最终结果揭晓之后。
    return {
      ...buildRateLimitedPolicy(normalizeText(options.detail), DEFAULT_RATE_LIMIT_COOLDOWN_MS),
      deferAccountFailureUntilRequestOutcome: true
    };
  }
  if (Number(options.statusCode) > 0) {
    return buildStatusPolicy(options);
  }
  return buildErrorPolicy(options);
}

module.exports = {
  classifyUpstreamFailure,
  describeError
};
