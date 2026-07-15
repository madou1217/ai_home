'use strict';

const AUTH_INVALID_BLOCK_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeReason(reason, fallback) {
  const text = String(reason || '').trim();
  return text || fallback;
}

function normalizeNowMs(nowMs) {
  const value = Number(nowMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}

function buildEmptyRuntimeStateBase(reason, nowMs) {
  return {
    cooldownUntil: 0,
    consecutiveFailures: 1,
    successCount: 0,
    failCount: 1,
    lastError: reason,
    lastFailureKind: '',
    lastFailureReason: reason,
    lastFailureAt: nowMs,
    lastSuccessAt: 0,
    rateLimitUntil: 0,
    authInvalidUntil: 0,
    overloadUntil: 0,
    networkUntil: 0,
    serviceUnavailableUntil: 0,
    upstreamErrorUntil: 0
  };
}

function buildAuthInvalidRuntimeState(reason, options = {}) {
  const now = normalizeNowMs(options.nowMs);
  const message = normalizeReason(reason, 'auth_invalid_reauth_required');
  const until = now + AUTH_INVALID_BLOCK_MS;
  return {
    ...buildEmptyRuntimeStateBase(message, now),
    cooldownUntil: until,
    lastFailureKind: 'auth_invalid',
    authInvalidUntil: until
  };
}

function buildRateLimitedRuntimeState(reason, options = {}) {
  const now = normalizeNowMs(options.nowMs);
  const message = normalizeReason(reason, 'rate_limited');
  const requestedCooldown = Number(options.cooldownMs);
  const cooldownMs = Number.isFinite(requestedCooldown) && requestedCooldown > 0
    ? requestedCooldown
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const until = now + Math.max(60_000, Math.min(cooldownMs, MAX_RATE_LIMIT_COOLDOWN_MS));
  return {
    ...buildEmptyRuntimeStateBase(message, now),
    cooldownUntil: until,
    lastFailureKind: 'rate_limited',
    rateLimitUntil: until
  };
}

module.exports = {
  buildAuthInvalidRuntimeState,
  buildRateLimitedRuntimeState
};
