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
  'upstreamErrorUntil',
  // Per-(account, model) cooldowns survive pool reloads / token refresh so a
  // just-rate-limited model isn't retried prematurely. Serialized as JSON in the
  // runtime_state TEXT column like the rest of these fields. NOT in
  // BLOCKING_RUNTIME_FIELDS: an account-wide success must not clear other
  // models' legitimate cooldowns (only a per-model success clears its own).
  'modelCooldowns',
  'modelFailureStreaks'
]);

const DEFAULT_MODEL_QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const BLOCKING_RUNTIME_FIELDS = Object.freeze([
  'cooldownUntil',
  'consecutiveFailures',
  'lastError',
  'lastFailureKind',
  'lastFailureReason',
  'lastFailureAt',
  'rateLimitUntil',
  'authInvalidUntil',
  'overloadUntil',
  'networkUntil',
  'serviceUnavailableUntil',
  'upstreamErrorUntil'
]);

function normalizeModelCooldownMap(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const key of Object.keys(value)) {
    const until = toFiniteNumber(value[key], 0);
    if (until > 0) out[key] = until;
  }
  return out;
}

function normalizeModelFailureMap(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const key of Object.keys(value)) {
    const count = Math.max(0, Math.trunc(toFiniteNumber(value[key], 0)));
    if (count > 0) out[key] = count;
  }
  return out;
}

function normalizeModelFailureStreakMap(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (!entry || typeof entry !== 'object') continue;
    const kind = String(entry.kind || '').trim();
    const count = Math.max(0, Math.trunc(toFiniteNumber(entry.count, 0)));
    const expiresAt = Math.max(0, toFiniteNumber(entry.expiresAt, 0));
    if (!kind || count < 1 || expiresAt < 1) continue;
    out[key] = {
      kind,
      count,
      expiresAt,
      reason: String(entry.reason || '')
    };
  }
  return out;
}

function modelCooldownKey(model) {
  return String(model || '').trim().toLowerCase();
}

function isQuotaExhaustedReason(account) {
  const text = [
    account && account.lastFailureKind,
    account && account.lastFailureReason,
    account && account.lastError
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).join('\n');
  return text.includes('model_quota_exhausted')
    || text.includes('resource has been exhausted')
    || text.includes('quota exhausted')
    || text.includes('quota exceeded')
    || (text.includes('resource_exhausted') && (text.includes('quota') || text.includes('check quota')));
}

function extendQuotaExhaustedModelCooldowns(account, legacyModelFailures, nowMs = Date.now()) {
  if (!account || !isQuotaExhaustedReason(account)) return account;
  const lastFailureAt = toFiniteNumber(account.lastFailureAt, 0);
  if (lastFailureAt <= 0) return account;
  const until = lastFailureAt + DEFAULT_MODEL_QUOTA_EXHAUSTED_COOLDOWN_MS;
  if (until <= nowMs) return account;
  const failures = legacyModelFailures && typeof legacyModelFailures === 'object' ? legacyModelFailures : {};
  const keys = Object.keys(failures).filter((key) => toFiniteNumber(failures[key], 0) > 0);
  if (keys.length < 1) return account;
  account.modelCooldowns = account.modelCooldowns && typeof account.modelCooldowns === 'object' ? account.modelCooldowns : {};
  keys.forEach((key) => {
    account.modelCooldowns[key] = Math.max(toFiniteNumber(account.modelCooldowns[key], 0), until);
  });
  return account;
}

function pruneExpiredModelRuntimeState(account, nowMs) {
  const cooldowns = account.modelCooldowns && typeof account.modelCooldowns === 'object'
    ? account.modelCooldowns
    : {};
  const streaks = account.modelFailureStreaks && typeof account.modelFailureStreaks === 'object'
    ? account.modelFailureStreaks
    : {};

  for (const key of Object.keys(cooldowns)) {
    if (toFiniteNumber(cooldowns[key], 0) > nowMs) continue;
    delete cooldowns[key];
    delete streaks[key];
  }
  for (const key of Object.keys(streaks)) {
    if (toFiniteNumber(streaks[key] && streaks[key].expiresAt, 0) > nowMs) continue;
    if (toFiniteNumber(cooldowns[key], 0) > nowMs) continue;
    delete streaks[key];
  }
  return account;
}

function normalizeAccountRuntime(account, nowMs = Date.now()) {
  if (!account || typeof account !== 'object') return account;
  const now = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  const legacyModelFailures = normalizeModelFailureMap(account.modelFailures);
  // Per-(account, model) cooldowns: a 429/quota/capacity failure on one model
  // must NOT take the whole account out of rotation; other models on the same
  // account stay usable. Account-wide fields below remain for auth/overload.
  account.modelCooldowns = normalizeModelCooldownMap(account.modelCooldowns);
  account.modelFailureStreaks = normalizeModelFailureStreakMap(account.modelFailureStreaks);
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
  // Legacy numeric modelFailures had no failure kind or expiry and therefore
  // cannot represent a consecutive streak safely. Use it only to preserve old
  // quota cooldowns, then remove it from the canonical runtime state.
  extendQuotaExhaustedModelCooldowns(account, legacyModelFailures, now);
  delete account.modelFailures;
  pruneExpiredModelRuntimeState(account, now);
  return account;
}

function clearBlockingAccountRuntimeState(account) {
  if (!account || typeof account !== 'object') return account;
  BLOCKING_RUNTIME_FIELDS.forEach((field) => {
    if (field === 'lastError' || field === 'lastFailureKind' || field === 'lastFailureReason') {
      account[field] = '';
      return;
    }
    account[field] = 0;
  });
  return normalizeAccountRuntime(account);
}

function replacePersistedAccountRuntimeState(account, persisted) {
  if (!account || typeof account !== 'object') return account;
  clearBlockingAccountRuntimeState(account);
  if (persisted && typeof persisted === 'object') {
    PERSISTED_RUNTIME_FIELDS.forEach((field) => {
      if (persisted[field] == null) return;
      account[field] = persisted[field];
    });
    if (persisted.modelFailures != null) account.modelFailures = persisted.modelFailures;
  }
  return normalizeAccountRuntime(account);
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

// Record a model-scoped failure (429/quota/capacity). Cools only this
// (account, model) tuple once the per-model failure threshold is reached;
// leaves account-wide runtime state untouched so other models keep flowing.
function touchAccountModelFailureState(account, policy, model, nowMs = Date.now()) {
  if (!account || !policy) return account;
  const now = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  normalizeAccountRuntime(account, now);
  const key = modelCooldownKey(model);
  if (!key) {
    // No model context: fall back to account-wide cooldown to stay safe.
    return touchAccountFailureState(account, policy, now);
  }
  const kind = String(policy.kind || policy.failureReason || 'upstream_failed');
  const reason = String(policy.failureReason || policy.detail || kind);
  const cooldownMs = Math.max(1000, toFiniteNumber(policy.cooldownMs, 0));
  const failureWindowMs = Math.max(
    1000,
    toFiniteNumber(policy.failureWindowMs, cooldownMs)
  );
  const previous = account.modelFailureStreaks[key];
  const continuesStreak = previous
    && previous.kind === kind
    && toFiniteNumber(previous.expiresAt, 0) > now;
  const count = continuesStreak ? previous.count + 1 : 1;

  account.lastFailureKind = kind;
  account.lastFailureReason = reason;
  account.lastFailureAt = now;
  const threshold = Math.max(1, Math.trunc(toFiniteNumber(policy.failureThreshold, 1)) || 1);
  const streak = {
    kind,
    count,
    expiresAt: now + failureWindowMs,
    reason
  };
  account.modelFailureStreaks[key] = streak;
  if (count >= threshold) {
    const until = now + cooldownMs;
    account.modelCooldowns[key] = Math.max(toFiniteNumber(account.modelCooldowns[key], 0), until);
    streak.expiresAt = Math.max(streak.expiresAt, until);
  }
  return account;
}

// Apply a classified upstream-failure policy to an account's runtime state.
//
// Account-scoped failures only engage the account-wide cooldown (the typed
// *Until buckets read by deriveAccountRuntimeStatus) once the consecutive
// failure streak reaches the policy threshold. Transient classes
// (network_error / timeout) carry a threshold of >= 2, so a single fetch-failed
// / socket blip records the failure but leaves the account routable; a brief
// shared-proxy hiccup can no longer empty the whole pool into
// no_available_account. Model-scoped failures (429 / quota / capacity) are
// delegated to markProxyAccountFailure with { scope:'model' } and never touch
// account-wide state.
//
// markProxyAccountFailure is injected (it lives in router.js) so this module
// stays dependency-free and there is no require cycle.
function applyAccountFailurePolicy(account, policy, options = {}) {
  if (!account || !policy || !policy.shouldMarkFailure) return account;
  const markProxyAccountFailure = typeof options.markProxyAccountFailure === 'function'
    ? options.markProxyAccountFailure
    : null;
  const model = String(options.model || '').trim();
  const threshold = Number.isFinite(Number(policy.failureThreshold)) && Number(policy.failureThreshold) > 0
    ? Number(policy.failureThreshold)
    : Math.max(1, toFiniteNumber(options.defaultThreshold, 1) || 1);
  const reason = policy.failureReason || policy.detail || policy.kind || 'upstream_failed';

  if (policy.scope === 'model' && model) {
    if (markProxyAccountFailure) {
      markProxyAccountFailure(account, reason, policy.cooldownMs || 0, threshold, {
        scope: 'model',
        model,
        kind: policy.kind,
        failureWindowMs: policy.failureWindowMs || policy.cooldownMs
      });
    } else {
      touchAccountModelFailureState(account, policy, model);
    }
    return account;
  }

  // A threshold of 1 means "cool on first failure": keep the legacy behavior
  // exactly (stamp the typed runtime cooldown immediately, then record the
  // failure). Only policies that explicitly ask for a streak (threshold >= 2,
  // i.e. the transient network/timeout classes) defer the account-wide cooldown
  // until consecutive failures pile up, so one blip never empties the pool.
  const gateByStreak = threshold > 1 && Boolean(markProxyAccountFailure);
  if (!gateByStreak) {
    touchAccountFailureState(account, policy);
    if (markProxyAccountFailure) {
      markProxyAccountFailure(account, reason, policy.cooldownMs || 0, threshold);
    }
    return account;
  }

  // Record the failure first so the consecutive-failure streak advances, then
  // only stamp the typed runtime cooldown once the streak reaches the threshold.
  markProxyAccountFailure(account, reason, policy.cooldownMs || 0, threshold);
  if (Number(account.consecutiveFailures || 0) >= threshold) {
    touchAccountFailureState(account, policy);
  }
  return account;
}

function getAccountModelCooldownUntil(account, model, nowMs = Date.now()) {
  if (!account || typeof account !== 'object') return 0;
  const map = account.modelCooldowns;
  if (!map || typeof map !== 'object') return 0;
  const until = toFiniteNumber(map[modelCooldownKey(model)], 0);
  return until > nowMs ? until : 0;
}

function clearAccountModelState(account, model) {
  if (!account || typeof account !== 'object') return account;
  const key = modelCooldownKey(model);
  if (!key) return account;
  if (account.modelCooldowns && typeof account.modelCooldowns === 'object') delete account.modelCooldowns[key];
  if (account.modelFailureStreaks && typeof account.modelFailureStreaks === 'object') {
    delete account.modelFailureStreaks[key];
  }
  if (account.modelFailures && typeof account.modelFailures === 'object') delete account.modelFailures[key];
  return account;
}

function clearExpiredAccountModelState(account, nowMs = Date.now()) {
  if (!account || typeof account !== 'object') return account;
  account.modelCooldowns = normalizeModelCooldownMap(account.modelCooldowns);
  account.modelFailureStreaks = normalizeModelFailureStreakMap(account.modelFailureStreaks);
  delete account.modelFailures;
  return pruneExpiredModelRuntimeState(account, Math.max(0, toFiniteNumber(nowMs, Date.now())));
}

function touchAccountSuccessState(account, nowMs = Date.now()) {
  if (!account) return account;
  clearBlockingAccountRuntimeState(account);
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
  if (persisted.modelFailures != null) account.modelFailures = persisted.modelFailures;
  return normalizeAccountRuntime(account);
}

module.exports = {
  normalizeAccountRuntime,
  clearBlockingAccountRuntimeState,
  replacePersistedAccountRuntimeState,
  touchAccountFailureState,
  touchAccountModelFailureState,
  applyAccountFailurePolicy,
  getAccountModelCooldownUntil,
  clearAccountModelState,
  clearExpiredAccountModelState,
  touchAccountSuccessState,
  clearExpiredAccountRuntimeState,
  deriveAccountRuntimeStatus,
  pickPersistedAccountRuntimeState,
  applyPersistedAccountRuntimeState,
  modelCooldownKey
};
