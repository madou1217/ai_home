'use strict';

const { isCustomUpstreamAccount } = require('../account/official-upstream-endpoint');

// A custom Codex account can front another AIH gateway.  In that shape the
// local account is only a transport slot; the remote gateway owns the real
// account pool and its quota windows.  Keep a tiny process-local gate so a
// remote `no_available_account` response does not make every local session
// immediately hit the same exhausted pool.

const DEFAULT_RETRY_AFTER_MS = 1_000;
const MIN_RETRY_AFTER_MS = 250;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;
const MAX_RECOVERY_WAIT_MS = 2_000;

const states = new Map();

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function clampRetryAfterMs(value, fallback = DEFAULT_RETRY_AFTER_MS) {
  const numeric = Number(value);
  const candidate = Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.ceil(candidate)));
}

function normalizeBaseUrl(account) {
  const raw = normalizeText(account && (account.openaiBaseUrl || account.baseUrl));
  if (!raw) return '';
  return raw.replace(/\/+$/, '').toLowerCase();
}

/**
 * Return a stable key only for API-key accounts that point at a custom
 * upstream.  OAuth and official Codex accounts must keep their normal local
 * account semantics.
 */
function remotePoolKey(account, model) {
  if (!account || !(account.apiKeyMode || account.authType === 'api-key')) return '';
  const baseUrl = normalizeBaseUrl(account);
  const requestedModel = normalizeText(model).toLowerCase();
  if (!baseUrl || !requestedModel) return '';
  if (!isCustomUpstreamAccount({
    provider: 'codex',
    apiKeyMode: true,
    baseUrl
  })) return '';
  return `${baseUrl}\u0000${requestedModel}`;
}

function retryAfterForState(state, nowMs) {
  if (!state) return DEFAULT_RETRY_AFTER_MS;
  const remaining = Number(state.cooldownUntil || 0) - nowMs;
  return clampRetryAfterMs(remaining > 0 ? remaining : state.retryAfterMs);
}

/**
 * Check whether a request may contact the remote pool now.  A recovery probe
 * in flight or an active cooldown blocks the request before it reaches the
 * remote gateway.  No state means normal operation.
 */
function beforeRemotePoolAttempt(key, nowMs = Date.now(), owner = null) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) return { allowed: true, retryAfterMs: 0 };
  const state = states.get(normalizedKey);
  if (!state) return { allowed: true, retryAfterMs: 0 };
  if (state.inFlight && state.owner === owner) {
    return { allowed: true, retryAfterMs: state.retryAfterMs, owner: true };
  }
  if (state.inFlight && state.owner !== owner) {
    return {
      allowed: false,
      retryAfterMs: retryAfterForState(state, nowMs),
      reason: 'probe_in_flight'
    };
  }
  if (Number(state.cooldownUntil || 0) > nowMs) {
    return {
      allowed: false,
      retryAfterMs: retryAfterForState(state, nowMs),
      reason: 'cooldown'
    };
  }
  states.delete(normalizedKey);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Claim the single recovery probe for a remote pool.  The first request is
 * the only one allowed to retry after a bounded wait; concurrent requests
 * receive the same retry window and do not stampede the remote server.
 */
function beginRemotePoolRecovery(key, retryAfterMs, nowMs = Date.now(), owner = null) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) {
    return { leader: true, retryAfterMs: clampRetryAfterMs(retryAfterMs), waitMs: 0 };
  }
  const state = states.get(normalizedKey);
  if (state && state.inFlight && state.owner !== owner) {
    return { leader: false, retryAfterMs: retryAfterForState(state, nowMs), reason: 'probe_in_flight' };
  }
  if (state && Number(state.cooldownUntil || 0) > nowMs) {
    return { leader: false, retryAfterMs: retryAfterForState(state, nowMs), reason: 'cooldown' };
  }
  const retryAfter = clampRetryAfterMs(retryAfterMs);
  states.set(normalizedKey, {
    inFlight: true,
    owner,
    retryAfterMs: retryAfter,
    cooldownUntil: 0,
    startedAt: nowMs
  });
  return {
    leader: true,
    retryAfterMs: retryAfter,
    // Never hold an HTTP/WS request for the full upstream reset window.  The
    // retry response still carries the complete Retry-After value.
    waitMs: Math.min(retryAfter, MAX_RECOVERY_WAIT_MS)
  };
}

function completeRemotePoolRecovery(key, result = {}, nowMs = Date.now()) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) return;
  const state = states.get(normalizedKey);
  if (!state) return;
  if (result.available === true) {
    states.delete(normalizedKey);
    return;
  }
  const retryAfter = clampRetryAfterMs(result.retryAfterMs || state.retryAfterMs);
  states.set(normalizedKey, {
    inFlight: false,
    owner: null,
    retryAfterMs: retryAfter,
    cooldownUntil: nowMs + retryAfter,
    startedAt: state.startedAt || nowMs
  });
}

function waitForRemotePoolRecovery(waitMs) {
  const delay = Math.max(0, Math.min(MAX_RECOVERY_WAIT_MS, Number(waitMs) || 0));
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function resetRemotePoolRecoveryForTests() {
  states.clear();
}

module.exports = {
  remotePoolKey,
  beforeRemotePoolAttempt,
  beginRemotePoolRecovery,
  completeRemotePoolRecovery,
  waitForRemotePoolRecovery,
  __private: {
    clampRetryAfterMs,
    resetRemotePoolRecoveryForTests,
    states,
    DEFAULT_RETRY_AFTER_MS,
    MAX_RECOVERY_WAIT_MS
  }
};
