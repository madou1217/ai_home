'use strict';

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const PERSISTED_RUNTIME_FIELDS = Object.freeze([
  'cooldownUntil',
  'consecutiveFailures',
  'successCount',
  'failCount',
  'lastError',
  'lastFailureKind',
  'lastFailureReason',
  'lastFailureAt',
  'lastSuccessAt',
  'rateLimitUntil',
  'authInvalidUntil',
  'overloadUntil',
  'networkUntil',
  'serviceUnavailableUntil',
  'upstreamErrorUntil'
]);

function normalizeAccountRuntime(account) {
  if (!account || typeof account !== 'object') return account;
  account.cooldownUntil = Math.max(0, toFiniteNumber(account.cooldownUntil, 0));
  account.consecutiveFailures = Math.max(0, toFiniteNumber(account.consecutiveFailures, 0));
  account.successCount = Math.max(0, toFiniteNumber(account.successCount, 0));
  account.failCount = Math.max(0, toFiniteNumber(account.failCount, 0));
  account.lastError = String(account.lastError || '');
  account.lastFailureKind = String(account.lastFailureKind || '');
  account.lastFailureReason = String(account.lastFailureReason || '');
  account.lastFailureAt = Math.max(0, toFiniteNumber(account.lastFailureAt, 0));
  account.lastSuccessAt = Math.max(0, toFiniteNumber(account.lastSuccessAt, 0));
  account.rateLimitUntil = Math.max(0, toFiniteNumber(account.rateLimitUntil, 0));
  account.authInvalidUntil = Math.max(0, toFiniteNumber(account.authInvalidUntil, 0));
  account.overloadUntil = Math.max(0, toFiniteNumber(account.overloadUntil, 0));
  account.networkUntil = Math.max(0, toFiniteNumber(account.networkUntil, 0));
  account.serviceUnavailableUntil = Math.max(0, toFiniteNumber(account.serviceUnavailableUntil, 0));
  account.upstreamErrorUntil = Math.max(0, toFiniteNumber(account.upstreamErrorUntil, 0));
  return account;
}

function touchAccountFailureState(account, policy, nowMs = Date.now()) {
  if (!account || !policy) return account;
  normalizeAccountRuntime(account);
  const until = Math.max(0, Number(nowMs) + Math.max(0, toFiniteNumber(policy.cooldownMs, 0)));
  account.lastFailureKind = String(policy.kind || '');
  account.lastFailureReason = String(policy.failureReason || policy.detail || '');
  account.lastFailureAt = Math.max(0, Number(nowMs) || Date.now());
  account.cooldownUntil = Math.max(account.cooldownUntil, until);

  if (policy.kind === 'rate_limited') {
    account.rateLimitUntil = Math.max(account.rateLimitUntil, until);
  } else if (policy.kind === 'auth_invalid') {
    account.authInvalidUntil = Math.max(account.authInvalidUntil, until);
  } else if (policy.kind === 'overloaded') {
    account.overloadUntil = Math.max(account.overloadUntil, until);
  } else if (policy.kind === 'timeout' || policy.kind === 'network_error') {
    account.networkUntil = Math.max(account.networkUntil, until);
  } else if (policy.kind === 'service_unavailable') {
    account.serviceUnavailableUntil = Math.max(account.serviceUnavailableUntil, until);
  } else if (policy.kind === 'upstream_server_error') {
    account.upstreamErrorUntil = Math.max(account.upstreamErrorUntil, until);
  }
  return account;
}

function touchAccountSuccessState(account, nowMs = Date.now()) {
  if (!account) return account;
  normalizeAccountRuntime(account);
  account.lastSuccessAt = Math.max(0, Number(nowMs) || Date.now());
  account.lastError = '';
  return account;
}

function clearExpiredAccountRuntimeState(account, nowMs = Date.now()) {
  if (!account || typeof account !== 'object') return account;
  normalizeAccountRuntime(account);
  const fields = [
    'rateLimitUntil',
    'authInvalidUntil',
    'overloadUntil',
    'networkUntil',
    'serviceUnavailableUntil',
    'upstreamErrorUntil'
  ];
  fields.forEach((field) => {
    if (toFiniteNumber(account[field], 0) <= nowMs) {
      account[field] = 0;
    }
  });
  if (account.cooldownUntil <= nowMs) {
    account.cooldownUntil = 0;
    account.consecutiveFailures = 0;
    if (
      !account.rateLimitUntil
      && !account.authInvalidUntil
      && !account.overloadUntil
      && !account.networkUntil
      && !account.serviceUnavailableUntil
      && !account.upstreamErrorUntil
    ) {
      account.lastFailureKind = '';
      account.lastFailureReason = '';
    }
  }
  return account;
}

function deriveAccountRuntimeStatus(account, nowMs = Date.now()) {
  if (!account) {
    return {
      status: 'unknown',
      until: 0,
      reason: ''
    };
  }
  normalizeAccountRuntime(account);
  const statusOrder = [
    ['auth_invalid', account.authInvalidUntil],
    ['rate_limited', account.rateLimitUntil],
    ['overloaded', account.overloadUntil],
    ['transient_network', account.networkUntil],
    ['service_unavailable', account.serviceUnavailableUntil],
    ['upstream_error', account.upstreamErrorUntil]
  ];
  for (const [status, until] of statusOrder) {
    if (toFiniteNumber(until, 0) > nowMs) {
      return {
        status,
        until: Number(until),
        reason: String(account.lastFailureReason || account.lastError || '')
      };
    }
  }
  if (account.cooldownUntil > nowMs) {
    return {
      status: account.lastFailureKind || 'cooling_down',
      until: Number(account.cooldownUntil),
      reason: String(account.lastFailureReason || account.lastError || '')
    };
  }
  return {
    status: 'healthy',
    until: 0,
    reason: ''
  };
}

function pickPersistedAccountRuntimeState(account) {
  if (!account || typeof account !== 'object') return null;
  normalizeAccountRuntime(account);
  const runtimeState = {};
  PERSISTED_RUNTIME_FIELDS.forEach((field) => {
    runtimeState[field] = account[field];
  });
  return runtimeState;
}

function applyPersistedAccountRuntimeState(account, persisted) {
  if (!account || typeof account !== 'object' || !persisted || typeof persisted !== 'object') {
    return account;
  }
  PERSISTED_RUNTIME_FIELDS.forEach((field) => {
    if (persisted[field] == null) return;
    account[field] = persisted[field];
  });
  return normalizeAccountRuntime(account);
}

module.exports = {
  normalizeAccountRuntime,
  touchAccountFailureState,
  touchAccountSuccessState,
  clearExpiredAccountRuntimeState,
  deriveAccountRuntimeStatus,
  pickPersistedAccountRuntimeState,
  applyPersistedAccountRuntimeState
};
