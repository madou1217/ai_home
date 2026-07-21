'use strict';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? Math.trunc(number) : null;
}

function createRetryStatus(input = {}) {
  const attempt = positiveInteger(input.attempt);

  const event = {
    type: 'retry-status',
    phase: normalizeString(input.phase) || 'scheduled',
    source: normalizeString(input.source) || 'provider-runtime',
    provider: normalizeString(input.provider).toLowerCase()
  };
  const maxAttempts = positiveInteger(input.maxAttempts);
  const retryAfterMs = finiteNumber(input.retryAfterMs);
  const retryAt = finiteNumber(input.retryAt);
  const status = finiteNumber(input.status);
  const reason = normalizeString(input.reason);
  const message = normalizeString(input.message);

  if (attempt) event.attempt = attempt;
  if (maxAttempts) event.maxAttempts = maxAttempts;
  if (retryAfterMs !== null && retryAfterMs >= 0) event.retryAfterMs = retryAfterMs;
  if (retryAt !== null && retryAt > 0) event.retryAt = retryAt;
  if (status !== null) event.status = status;
  if (reason) event.reason = reason;
  if (message) event.message = message;
  return event;
}

function mapClaudeApiRetry(message) {
  if (!message || message.type !== 'system' || message.subtype !== 'api_retry') return null;
  return createRetryStatus({
    phase: 'scheduled',
    source: 'upstream-api',
    provider: 'claude',
    attempt: message.attempt,
    maxAttempts: message.max_retries,
    retryAfterMs: message.retry_delay_ms,
    status: message.error_status,
    reason: message.error
  });
}

function mapOpenCodeRetryPart(message) {
  if (!message || message.type !== 'retry') return null;
  const part = message.part && typeof message.part === 'object' ? message.part : message;
  const error = part.error && typeof part.error === 'object' ? part.error : {};
  return createRetryStatus({
    phase: 'scheduled',
    source: 'provider-runtime',
    provider: 'opencode',
    attempt: part.attempt,
    status: error.statusCode || error.status,
    reason: error.name || error.code,
    message: error.message || (typeof part.error === 'string' ? part.error : '')
  });
}

function mapOpenCodeSessionRetry(event) {
  const properties = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : {};
  const status = properties.status && typeof properties.status === 'object'
    ? properties.status
    : {};
  if (!event || event.type !== 'session.status' || status.type !== 'retry') return null;
  return createRetryStatus({
    phase: 'scheduled',
    source: 'provider-runtime',
    provider: 'opencode',
    attempt: status.attempt,
    retryAt: status.next,
    message: status.message
  });
}

module.exports = {
  createRetryStatus,
  mapClaudeApiRetry,
  mapOpenCodeRetryPart,
  mapOpenCodeSessionRetry
};
