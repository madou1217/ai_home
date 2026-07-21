'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  replacePersistedAccountRuntimeState,
  deriveAccountRuntimeStatus,
  getAccountModelCooldownUntil
} = require('./account-runtime-state');

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

function syncPersistedRuntimeState(account, provider, accountStateIndex) {
  if (!account || !accountStateIndex || typeof accountStateIndex.getAccountState !== 'function') return account;
  const accountRef = String(account.accountRef || '').trim();
  if (!provider || !accountRef) return account;
  const row = accountStateIndex.getAccountState(accountRef);
  if (!row) return account;
  if (Object.prototype.hasOwnProperty.call(row, 'runtimeState')) {
    return replacePersistedAccountRuntimeState(account, row.runtimeState);
  }
  return account;
}

function resolveCursorState(state, options = {}) {
  if (options.cursorState && typeof options.cursorState === 'object') return options.cursorState;
  if (state && state.cursors && typeof state.cursors === 'object') return state.cursors;
  return state || {};
}

function resolveSelectionStrategy(state, options = {}) {
  return String(
    options.strategy
    || state && state.strategy
    || 'round-robin'
  ).trim().toLowerCase();
}

function chooseServerAccount(accounts, state, cursorKey = 'cursor', options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const now = Date.now();
  const provider = String(options.provider || '').trim().toLowerCase();
  const accountStateIndex = options.accountStateIndex || null;
  const excludedRefsInput = options.excludeAccountRefs;
  const excludedRefs = excludedRefsInput instanceof Set
    ? excludedRefsInput
    : new Set(Array.isArray(excludedRefsInput) ? excludedRefsInput : []);
  const model = String(options.model || '').trim();
  // Last-resort override: bypass ONLY the soft per-(account, model) cooldown so a
  // request can still be served when every candidate is merely model-cooled
  // (rather than 503'ing the client). Account-level/hard blocks below — runtime
  // status (auth_invalid etc.), account-wide cooldownUntil, schedulable status,
  // exhausted quota — are NOT bypassed.
  const allowModelCooled = Boolean(options.allowModelCooled);
  const available = accounts.filter((account) => {
    syncPersistedRuntimeState(account, provider, accountStateIndex);
    const runtimeStatus = deriveAccountRuntimeStatus(account, now);
    if (runtimeStatus.status !== 'healthy') return false;
    if (now < Number(account && account.cooldownUntil || 0)) return false;
    // Per-(account, model) cooldown: skip this account only for the requested
    // model; it remains eligible for its other (non-cooled) models.
    if (!allowModelCooled && model && getAccountModelCooldownUntil(account, model, now) > now) return false;
    if (account && String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
    if (account && !account.apiKeyMode) {
      const pct = account.remainingPct;
      if (pct != null && pct !== '' && Number.isFinite(Number(pct)) && Number(pct) <= 0) return false;
    }
    const accountRef = String(account && account.accountRef || '');
    if (accountRef && excludedRefs.has(accountRef)) return false;
    return true;
  });
  if (available.length === 0) return null;

  const sessionKey = String(options.sessionKey || '').trim();
  const affinity = sessionKey ? ensureSessionAffinity(state) : null;
  const affinityMap = affinity && provider && affinity[provider] instanceof Map ? affinity[provider] : null;

  if (affinityMap && sessionKey) {
    purgeSessionMap(affinityMap, now);
    const bound = affinityMap.get(sessionKey);
    if (bound && String(bound.accountRef || '').trim()) {
      const hit = available.find((account) => String(account.accountRef || '') === String(bound.accountRef));
      if (hit) {
        bound.expiresAt = now + Number(affinity.ttlMs);
        affinityMap.set(sessionKey, bound);
        return hit;
      }
      affinityMap.delete(sessionKey);
    }
  }

  const preferredAccountRef = String(options.preferredAccountRef || '').trim();
  let picked = preferredAccountRef
    ? available.find((account) => String(account && account.accountRef || '').trim() === preferredAccountRef) || null
    : null;
  const strategy = resolveSelectionStrategy(state, options);
  const cursorState = resolveCursorState(state, options);
  if (!picked && strategy === 'random') {
    picked = pickWeightedRandomAccount(available);
  } else if (!picked) {
    const availableSet = new Set(available);
    const total = accounts.length;
    const cursor = Number(cursorState[cursorKey] || 0);
    for (let i = 0; i < total; i += 1) {
      const idx = (cursor + i) % total;
      const account = accounts[idx];
      if (!availableSet.has(account)) continue;
      cursorState[cursorKey] = (idx + 1) % total;
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
      accountRef: String(picked.accountRef || ''),
      expiresAt: now + Number(affinity.ttlMs)
    });
  }

  return picked;
}

module.exports = {
  chooseServerAccount,
  pickWeightedRandomAccount
};
