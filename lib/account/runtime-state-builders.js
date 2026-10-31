'use strict';

const { ACCOUNT_GUESSED_COOLDOWN_MS } = require('../cli/config/constants');

// 凭据失效的复核间隔（旧：365 天）。终端输出 / CLI 本地判定写入的 auth_invalid 也只是一次
// 观察：到期后由下一次真实请求复核，还失败就再标一次。与 upstream-failure-policy 同值。
const AUTH_INVALID_BLOCK_MS = ACCOUNT_GUESSED_COOLDOWN_MS;
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

// 上游明确拒绝该账号（地区/资格/权限），不是限流也不是凭据失效：
// 用 routingBlock（kind=permission_denied）表达 —— 与 billing_blocked / quota_exhausted 同类，
// 只有人工清除（或账号/地区状态改变后的人工恢复）才会重新入池，探测成功不会把它推翻。
function buildPermissionDeniedRuntimeState(reason, options = {}) {
  const now = normalizeNowMs(options.nowMs);
  const message = normalizeReason(reason, 'permission_denied');
  return {
    ...buildEmptyRuntimeStateBase(message, now),
    lastFailureKind: 'permission_denied',
    routingBlock: { kind: 'permission_denied', reason: message, observedAt: now }
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
  buildPermissionDeniedRuntimeState,
  buildRateLimitedRuntimeState
};
