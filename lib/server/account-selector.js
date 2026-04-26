'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

const DEFAULT_SESSION_AFFINITY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_AFFINITY_MAX = 10_000;

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
  const weights = available.map((account) => {
    const pct = Number(account && account.remainingPct);
    if (Number.isFinite(pct)) return Math.max(1, Math.round(pct));
    return 1;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
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
  const available = accounts.filter((account) => {
    if (now < Number(account && account.cooldownUntil || 0)) return false;
    if (account && String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
    if (account && !account.apiKeyMode) {
      const pct = account.remainingPct;
      if (pct != null && pct !== '' && Number.isFinite(Number(pct)) && Number(pct) <= 0) return false;
    }
    const id = String(account && account.id || '');
    if (id && excludeIds.has(id)) return false;
    return true;
  });
  if (available.length === 0) return null;

  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionKey = String(options.sessionKey || '').trim();
  const affinity = sessionKey ? ensureSessionAffinity(state) : null;
  const affinityMap = affinity && provider && affinity[provider] instanceof Map ? affinity[provider] : null;

  if (affinityMap && sessionKey) {
    purgeSessionMap(affinityMap, now);
    const bound = affinityMap.get(sessionKey);
    if (bound && String(bound.accountId || '').trim()) {
      const hit = available.find((account) => String(account.id || '') === String(bound.accountId));
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
    const total = available.length;
    const cursor = Number(state[cursorKey] || 0);
    for (let i = 0; i < total; i += 1) {
      const idx = (cursor + i) % total;
      const account = available[idx];
      state[cursorKey] = (idx + 1) % total;
      picked = account;
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

module.exports = {
  chooseServerAccount,
  pickWeightedRandomAccount
};
