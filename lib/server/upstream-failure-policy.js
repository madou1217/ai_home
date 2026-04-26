'use strict';

const { parseProviderRetryHintMs } = require('./retry-hints');

const DEFAULT_LONG_AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_SERVER_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_COOLDOWN_MS = 5 * 60 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function isCapacityOverloadDetail(options = {}) {
  const detail = [
    options.detail,
    options.body,
    describeError(options.error)
  ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join('\n');
  return detail.includes('selected model is at capacity. please try a different model.')
    || detail.includes('selected model is at capacity');
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

function isNetworkError(error) {
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  if (['ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  const message = describeError(error).toLowerCase();
  return message.includes('fetch failed')
    || message.includes('network socket disconnected')
    || message.includes('secure tls connection');
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

  if (statusCode === 400 && isCapacityOverloadDetail(options)) {
    return {
      kind: 'overloaded',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS),
      clientStatusCode: 503,
      failureReason: detail,
      detail,
      scope: 'account',
      shouldUnbindSession: false
    };
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
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_LONG_AUTH_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: `upstream_${statusCode}`,
      detail,
      scope: 'account',
      shouldUnbindSession: true
    };
  }

  if (statusCode === 429) {
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
      scope: 'account',
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
      scope: 'account',
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
      scope: 'account',
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
      scope: 'account',
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
  const timeoutError = isTimeoutError(options.error);
  const networkError = isNetworkError(options.error);

  if (timeoutError) {
    return {
      kind: 'timeout',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_TIMEOUT_COOLDOWN_MS),
      clientStatusCode: 504,
      failureReason: detail,
      detail,
      scope: 'account',
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
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_TIMEOUT_COOLDOWN_MS),
      clientStatusCode: 502,
      failureReason: detail,
      detail,
      scope: 'account',
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
    scope: 'account',
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
