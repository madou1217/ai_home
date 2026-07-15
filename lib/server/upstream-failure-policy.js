'use strict';

const { parseProviderRetryHintMs } = require('./retry-hints');

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
const DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// A monthly usage cap (e.g. opencode GoUsageLimitError "resets in N days") blocks
// the whole workspace/account until reset, so cool the ACCOUNT (all its models),
// not just one (account, model). Floor 24h, cap 30d if the reset hint is huge.
const DEFAULT_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

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
    failureThreshold: 1,
    cooldownMs: Math.max(defaultCooldownMs, DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS),
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

  if (statusCode === 429 && isProviderUsageLimitReachedDetail(options)) {
    return buildAccountUsageExhaustedPolicy(
      detail,
      parseUsageLimitResetCooldownMs(detail) || retryHintMs
    );
  }

  if (statusCode === 429 && isProviderQuotaExhaustedDetail(options)) {
    return buildModelQuotaExhaustedPolicy(detail, 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS
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
    return buildModelCapacityPolicy(detail, statusCode || 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS
    });
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

  if (statusCode === 429) {
    // A 429 is bound to (provider, account, model): the same account's other
    // models often still have quota (e.g. agy claude 429 while gemini-3.5-flash
    // is fine). Cool only this model so the account stays usable elsewhere and
    // alias fallback can switch models.
    return {
      kind: 'rate_limited',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      clientStatusCode: 429,
      failureReason: detail,
      detail,
      scope: 'model',
      shouldUnbindSession: true
    };
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
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      // Same transient treatment as timeouts: one fetch-failed blip must not
      // cool the (account, model); only a sustained streak does, and only briefly.
      failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
      cooldownMs: DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS,
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
  if (Number(options.statusCode) > 0) {
    return buildStatusPolicy(options);
  }
  return buildErrorPolicy(options);
}

module.exports = {
  classifyUpstreamFailure,
  describeError
};
