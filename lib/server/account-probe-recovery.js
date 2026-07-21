'use strict';

// Probe-driven account recovery: a credentialed models probe that comes back
// with a non-empty catalog is direct evidence the account's credentials work
// NOW. Without this, an auth_invalid circuit (persisted for up to a year)
// deadlocks accounts whose keys were fixed outside the aih login flow (e.g.
// an edited opencode auth.json): blocked → never routed → never records a
// success → never unblocks. Runs after every models-cache refresh.

function clearAccountRuntimeBlock(account) {
  if (!account || typeof account !== 'object') return;
  account.cooldownUntil = 0;
  account.consecutiveFailures = 0;
  account.lastError = '';
  account.lastFailureKind = '';
  account.lastFailureReason = '';
  account.lastFailureAt = 0;
  account.rateLimitUntil = 0;
  account.authInvalidUntil = 0;
  account.overloadUntil = 0;
  account.networkUntil = 0;
  account.serviceUnavailableUntil = 0;
  account.upstreamErrorUntil = 0;
}

// AUTH-blocked only. A successful models probe proves the CREDENTIALS work —
// it says nothing about usage limits: /models often stays 200 while chat is
// 429-limited. Recovering rate-limit/overload cooldowns here would wipe them
// on every scheduler pass, throw the account straight back into rotation and
// hammer the limited upstream in a loop (observed live: opencode failCount 48
// with rateLimitUntil repeatedly reset to 0).
function isAccountAuthBlocked(account, now = Date.now()) {
  if (!account || typeof account !== 'object') return false;
  return Number(account.authInvalidUntil || 0) > now
    || String(account.lastFailureKind || '').trim() === 'auth_invalid';
}

function accountProbeSucceeded(discovery, accountRefs) {
  const sources = discovery && discovery.sourcesByAccount || {};
  const byAccount = discovery && discovery.byAccount || {};
  return (Array.isArray(accountRefs) ? accountRefs : []).some((accountRef) => (
    String(sources[accountRef] || '') === 'remote'
    && Array.isArray(byAccount[accountRef])
    && byAccount[accountRef].length > 0
  ));
}

// Clear runtime blocks (memory + persisted) for accounts whose remote probe
// just succeeded. Returns the recovered accounts for logging.
function recoverProbedAccounts(state, discovery, deps = {}) {
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  const listCacheRefs = deps.listAccountModelCacheRefs;
  const accountStateService = deps.accountStateService;
  const now = Date.now();
  const recovered = [];
  if (typeof listCacheRefs !== 'function') return recovered;
  Object.keys(accountsByProvider).forEach((provider) => {
    const accounts = Array.isArray(accountsByProvider[provider]) ? accountsByProvider[provider] : [];
    accounts.forEach((account) => {
      if (!isAccountAuthBlocked(account, now)) return;
      const accountRefs = listCacheRefs(provider, account);
      if (!accountProbeSucceeded(discovery, accountRefs)) return;
      clearAccountRuntimeBlock(account);
      const accountRef = String(account && account.accountRef || '').trim();
      if (accountRef && accountStateService && typeof accountStateService.clearRuntimeBlock === 'function') {
        try {
          accountStateService.clearRuntimeBlock(accountRef, provider, {
            configured: true,
            apiKeyMode: Boolean(account.apiKeyMode || account.authType === 'api-key'),
            displayName: String(account.displayName || account.email || '').trim(),
            evidence: 'models_probe_success'
          });
        } catch (_error) {}
      }
      recovered.push({ provider, accountRef });
    });
  });
  return recovered;
}

module.exports = {
  accountProbeSucceeded,
  clearAccountRuntimeBlock,
  isAccountAuthBlocked,
  recoverProbedAccounts
};
