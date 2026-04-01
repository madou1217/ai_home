'use strict';

const { inferProviderFromModel, SUPPORTED_SERVER_PROVIDERS } = require('./providers');

const DEFAULT_SESSION_AFFINITY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_AFFINITY_MAX = 10_000;

function resolveRequestProvider(options, requestJson) {
  const requested = String(requestJson && requestJson.model || '');
  if (SUPPORTED_SERVER_PROVIDERS.includes(options.provider)) return options.provider;
  return inferProviderFromModel(requested);
}

function ensureSessionAffinity(state) {
  if (!state || typeof state !== 'object') return null;
  if (!state.sessionAffinity || typeof state.sessionAffinity !== 'object') {
    state.sessionAffinity = {
      ttlMs: DEFAULT_SESSION_AFFINITY_TTL_MS,
      maxEntries: DEFAULT_SESSION_AFFINITY_MAX
    };
  }
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    if (!(state.sessionAffinity[provider] instanceof Map)) state.sessionAffinity[provider] = new Map();
  });
  if (!Number.isFinite(Number(state.sessionAffinity.ttlMs)) || Number(state.sessionAffinity.ttlMs) <= 0) {
    state.sessionAffinity.ttlMs = DEFAULT_SESSION_AFFINITY_TTL_MS;
  }
  if (!Number.isFinite(Number(state.sessionAffinity.maxEntries)) || Number(state.sessionAffinity.maxEntries) <= 0) {
    state.sessionAffinity.maxEntries = DEFAULT_SESSION_AFFINITY_MAX;
  }
  return state.sessionAffinity;
}

function purgeSessionMap(sessionMap, now) {
  if (!(sessionMap instanceof Map)) return;
  sessionMap.forEach((entry, key) => {
    if (!entry || !Number.isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) <= now) {
      sessionMap.delete(key);
    }
  });
}

function pickWeightedRandomAccount(available) {
  if (!Array.isArray(available) || available.length === 0) return null;
  const weights = available.map((acc) => {
    const pct = Number(acc && acc.remainingPct);
    if (Number.isFinite(pct)) return Math.max(1, Math.round(pct));
    return 1;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  let offset = Math.random() * total;
  for (let i = 0; i < available.length; i += 1) {
    offset -= weights[i];
    if (offset <= 0) return available[i];
  }
  return available[available.length - 1];
}

function chooseServerAccount(accounts, state, cursorKey = 'cursor', options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const now = Date.now();
  const excludeIdsInput = options.excludeIds;
  const excludeIds = excludeIdsInput instanceof Set
    ? excludeIdsInput
    : new Set(Array.isArray(excludeIdsInput) ? excludeIdsInput : []);
  const available = accounts.filter((a) => {
    if (now < (a.cooldownUntil || 0)) return false;
    const id = String((a && a.id) || '');
    if (id && excludeIds.has(id)) return false;
    return true;
  });
  if (available.length === 0) return null;
  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionKey = String(options.sessionKey || '').trim();
  const affinity = sessionKey ? ensureSessionAffinity(state) : null;
  const affinityMap = (affinity && provider && affinity[provider] instanceof Map) ? affinity[provider] : null;

  if (affinityMap && sessionKey) {
    purgeSessionMap(affinityMap, now);
    const bound = affinityMap.get(sessionKey);
    if (bound && String(bound.accountId || '').trim()) {
      const hit = available.find((a) => String(a.id || '') === String(bound.accountId));
      if (hit) {
        bound.expiresAt = now + Number(affinity.ttlMs);
        affinityMap.set(sessionKey, bound);
        return hit;
      }
      affinityMap.delete(sessionKey);
    }
  }

  let picked = null;
  if (state.strategy === 'random') {
    picked = pickWeightedRandomAccount(available);
  } else {
    const n = accounts.length;
    const cursor = Number(state[cursorKey] || 0);
    for (let i = 0; i < n; i += 1) {
      const idx = (cursor + i) % n;
      const item = accounts[idx];
      if (now < (item.cooldownUntil || 0)) continue;
      state[cursorKey] = (idx + 1) % n;
      picked = item;
      break;
    }
  }

  if (picked && affinityMap && sessionKey) {
    if (affinityMap.size >= Number(affinity.maxEntries)) {
      const oldest = affinityMap.keys().next();
      if (!oldest.done) affinityMap.delete(oldest.value);
    }
    affinityMap.set(sessionKey, {
      accountId: String(picked.id || ''),
      expiresAt: now + Number(affinity.ttlMs)
    });
  }
  return picked;
}

function markProxyAccountSuccess(account) {
  if (!account) return;
  account.consecutiveFailures = 0;
  account.successCount = Number(account.successCount || 0) + 1;
  account.lastError = '';
}

function markProxyAccountFailure(account, reason, cooldownMs, failureThreshold = 2) {
  if (!account) return;
  account.failCount = Number(account.failCount || 0) + 1;
  account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
  account.lastError = String(reason || '');
  if (account.consecutiveFailures >= failureThreshold) {
    account.cooldownUntil = Date.now() + cooldownMs;
  }
}

module.exports = {
  resolveRequestProvider,
  chooseServerAccount,
  pickWeightedRandomAccount,
  markProxyAccountSuccess,
  markProxyAccountFailure
};
