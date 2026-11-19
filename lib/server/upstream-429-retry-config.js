'use strict';

const UPSTREAM_429_RETRY_LIMITS = Object.freeze({
  minSteps: 1,
  maxSteps: 10,
  minStepSeconds: 1,
  maxStepSeconds: 300,
  maxTotalSeconds: 900
});

const DEFAULT_UPSTREAM_429_RETRY = Object.freeze({
  enabled: true,
  backoffSeconds: Object.freeze([30])
});

const INVALID_UPSTREAM_429_RETRY_ERROR = 'invalid_upstream_429_retry_config';

function cloneDefaultUpstream429Retry() {
  return {
    enabled: DEFAULT_UPSTREAM_429_RETRY.enabled,
    backoffSeconds: [...DEFAULT_UPSTREAM_429_RETRY.backoffSeconds]
  };
}

function makeValidationError(message) {
  const error = new Error(message);
  error.code = INVALID_UPSTREAM_429_RETRY_ERROR;
  return error;
}

function validateUpstream429BackoffSeconds(value) {
  if (!Array.isArray(value)) {
    throw makeValidationError('backoffSeconds must be an array of integers');
  }
  if (value.length < UPSTREAM_429_RETRY_LIMITS.minSteps) {
    throw makeValidationError('backoffSeconds must contain at least 1 step');
  }
  if (value.length > UPSTREAM_429_RETRY_LIMITS.maxSteps) {
    throw makeValidationError(`backoffSeconds supports at most ${UPSTREAM_429_RETRY_LIMITS.maxSteps} steps`);
  }
  let sum = 0;
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item)) {
      throw makeValidationError(`backoffSeconds[${i}] must be a finite integer`);
    }
    if (item < UPSTREAM_429_RETRY_LIMITS.minStepSeconds || item > UPSTREAM_429_RETRY_LIMITS.maxStepSeconds) {
      throw makeValidationError(
        `backoffSeconds[${i}] must be between ${UPSTREAM_429_RETRY_LIMITS.minStepSeconds} and ${UPSTREAM_429_RETRY_LIMITS.maxStepSeconds} seconds`
      );
    }
    sum += item;
    if (sum > UPSTREAM_429_RETRY_LIMITS.maxTotalSeconds) {
      throw makeValidationError(`backoffSeconds cumulative total must not exceed ${UPSTREAM_429_RETRY_LIMITS.maxTotalSeconds} seconds`);
    }
    out.push(item);
  }
  return out;
}

function sanitizeUpstream429Retry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return cloneDefaultUpstream429Retry();
  }
  const enabled = typeof input.enabled === 'boolean'
    ? input.enabled
    : DEFAULT_UPSTREAM_429_RETRY.enabled;
  let backoffSeconds = [...DEFAULT_UPSTREAM_429_RETRY.backoffSeconds];
  if (Array.isArray(input.backoffSeconds)) {
    try {
      backoffSeconds = validateUpstream429BackoffSeconds(input.backoffSeconds);
    } catch (_err) {
      backoffSeconds = [...DEFAULT_UPSTREAM_429_RETRY.backoffSeconds];
    }
  }
  return { enabled, backoffSeconds };
}

function validateUpstream429RetryPatch(patch, base) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw makeValidationError('upstream429Retry must be a JSON object');
  }
  const normalizedBase = sanitizeUpstream429Retry(base);
  const next = {
    enabled: normalizedBase.enabled,
    backoffSeconds: [...normalizedBase.backoffSeconds]
  };
  for (const key of Object.keys(patch)) {
    if (key === 'enabled') {
      if (typeof patch.enabled !== 'boolean') {
        throw makeValidationError('upstream429Retry.enabled must be a boolean');
      }
      next.enabled = patch.enabled;
    } else if (key === 'backoffSeconds') {
      next.backoffSeconds = validateUpstream429BackoffSeconds(patch.backoffSeconds);
    } else {
      throw makeValidationError(`upstream429Retry contains unsupported field "${key}"`);
    }
  }
  next.backoffSeconds = validateUpstream429BackoffSeconds(next.backoffSeconds);
  return next;
}

function mergeUpstream429RetryPatch(base, patch) {
  const normalizedBase = sanitizeUpstream429Retry(base);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return normalizedBase;
  }
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : normalizedBase.enabled,
    backoffSeconds: normalizedBase.backoffSeconds
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'backoffSeconds')) {
    try {
      next.backoffSeconds = validateUpstream429BackoffSeconds(patch.backoffSeconds);
    } catch (_err) {
      next.backoffSeconds = normalizedBase.backoffSeconds;
    }
  }
  return next;
}

function mergePersistedUpstream429Retry(rawExisting, normalizedPolicy) {
  const existing = rawExisting && typeof rawExisting === 'object' && !Array.isArray(rawExisting)
    ? rawExisting
    : {};
  const normalized = sanitizeUpstream429Retry(normalizedPolicy);
  return {
    ...existing,
    enabled: normalized.enabled,
    backoffSeconds: [...normalized.backoffSeconds]
  };
}

function parseUpstream429BackoffCsv(raw, flagName = '--upstream-429-retry-backoff') {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) {
    throw makeValidationError(`${flagName} requires comma-separated integer seconds (e.g. 30 or 10,30,60)`);
  }
  const parts = text.split(',').map((item) => item.trim()).filter(Boolean);
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw makeValidationError(`${flagName} contains invalid integer "${part}"`);
    }
    return Number(part);
  });
  return validateUpstream429BackoffSeconds(numbers);
}

module.exports = {
  UPSTREAM_429_RETRY_LIMITS,
  DEFAULT_UPSTREAM_429_RETRY,
  INVALID_UPSTREAM_429_RETRY_ERROR,
  cloneDefaultUpstream429Retry,
  validateUpstream429BackoffSeconds,
  validateUpstream429RetryPatch,
  sanitizeUpstream429Retry,
  mergeUpstream429RetryPatch,
  mergePersistedUpstream429Retry,
  parseUpstream429BackoffCsv
};
