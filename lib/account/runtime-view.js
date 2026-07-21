'use strict';

const { deriveAccountRuntimeStatus } = require('../server/account-runtime-state');

const RUNTIME_STATUS_PRIORITY = Object.freeze({
  auth_invalid: 60,
  rate_limited: 50,
  overloaded: 40,
  service_unavailable: 35,
  transient_network: 30,
  upstream_error: 25,
  cooling_down: 20,
  unknown: 0,
  healthy: 0
});

function readRuntimeState(value) {
  if (!value || typeof value !== 'object') return null;
  const nested = value.runtimeState;
  if (nested && typeof nested === 'object') return nested;
  if (
    value.authInvalidUntil != null
    || value.rateLimitUntil != null
    || value.overloadUntil != null
    || value.networkUntil != null
    || value.serviceUnavailableUntil != null
    || value.upstreamErrorUntil != null
    || value.cooldownUntil != null
  ) {
    return value;
  }
  return null;
}

function deriveRuntimeStatus(value, nowMs = Date.now()) {
  const runtimeState = readRuntimeState(value);
  if (!runtimeState) {
    return {
      status: 'healthy',
      until: 0,
      reason: ''
    };
  }
  return deriveAccountRuntimeStatus(runtimeState, nowMs);
}

function hasPersistedRuntimeSource(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, 'runtimeState')) return true;
  return readRuntimeState(value) !== null;
}

function normalizeRuntimeStatus(status) {
  return String(status && status.status || status || '').trim().toLowerCase();
}

function isBlockingRuntimeStatus(status) {
  const normalized = normalizeRuntimeStatus(status);
  return Boolean(normalized && normalized !== 'healthy' && normalized !== 'unknown');
}

function isAuthInvalidRuntimeStatus(status) {
  return normalizeRuntimeStatus(status) === 'auth_invalid';
}

function getRuntimeStatusPriority(status) {
  const normalized = normalizeRuntimeStatus(status);
  return Number(RUNTIME_STATUS_PRIORITY[normalized] || 0);
}

function pickRuntimeStatus(...statuses) {
  return statuses
    .filter(Boolean)
    .reduce((picked, current) => {
      if (!picked) return current;
      return getRuntimeStatusPriority(current) > getRuntimeStatusPriority(picked)
        ? current
        : picked;
    }, null) || {
      status: 'healthy',
      until: 0,
      reason: ''
    };
}

function deriveEffectiveRuntimeStatus(runtimeAccount, stateInfo, nowMs = Date.now()) {
  // 需求：CLI、WebUI、server 调度必须以 account_state.runtime_state 为同一真相源。
  // 如果持久态记录存在，即使值为 null，也表示该账号当前没有持久运行态阻塞。
  if (hasPersistedRuntimeSource(stateInfo)) {
    return deriveRuntimeStatus(stateInfo, nowMs);
  }
  return runtimeAccount
    ? deriveAccountRuntimeStatus(runtimeAccount, nowMs)
    : deriveRuntimeStatus(null, nowMs);
}

function formatRuntimeStatusText(status) {
  const normalized = normalizeRuntimeStatus(status);
  if (normalized === 'auth_invalid') return 'auth expired';
  if (normalized === 'rate_limited') return 'rate limited';
  if (normalized === 'overloaded') return 'overloaded';
  if (normalized === 'transient_network') return 'network cooling down';
  if (normalized === 'service_unavailable') return 'service unavailable';
  if (normalized === 'upstream_error') return 'upstream error';
  if (normalized === 'cooling_down') return 'cooling down';
  return normalized || 'runtime unavailable';
}

function formatRuntimeStatusSummary(status, accountLabel) {
  return `account ${String(accountLabel || '').trim()} ${formatRuntimeStatusText(status)}`;
}

function formatRuntimeStatusLabel(status) {
  if (isAuthInvalidRuntimeStatus(status)) return '[Auth: expired]';
  return `[Runtime: ${formatRuntimeStatusText(status)}]`;
}

module.exports = {
  readRuntimeState,
  deriveRuntimeStatus,
  deriveEffectiveRuntimeStatus,
  hasPersistedRuntimeSource,
  pickRuntimeStatus,
  normalizeRuntimeStatus,
  isBlockingRuntimeStatus,
  isAuthInvalidRuntimeStatus,
  formatRuntimeStatusText,
  formatRuntimeStatusSummary,
  formatRuntimeStatusLabel
};
