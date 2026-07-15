'use strict';

const { resolveEffectiveAccountStatus } = require('../../../account/status-file');
const {
  deriveQuotaState,
  deriveSchedulableState
} = require('../../../account/derived-state');
const {
  clearRecoverableAgyAuthInvalidBlock
} = require('../../../account/agy-auth-recovery');
const {
  deriveRuntimeStatus
} = require('../../../account/runtime-view');
const {
  hasAccountCredentials,
  readAccountCredentialRecord
} = require('../../../server/account-credential-store');
const {
  listCliAccountCredentialRecords
} = require('../account/credential-records');
const {
  isAccountRef
} = require('../../../server/account-ref-store');

function createUsageAccountRuntimeService(options = {}) {
  const {
    fs,
    aiHomeDir,
    cliConfigs,
    createUsageScheduler,
    getAccountStateIndex,
    accountStateService,
    accountQueryService,
    lastActiveAccountByCli,
    usageIndexStaleRefreshMs,
    usageIndexBgRefreshLimit,
    checkStatus,
    readUsageCache,
    ensureUsageSnapshot
  } = options;

  let accountUsageRefreshScheduler = null;

  function getIndexedAccountState(accountRef) {
    const index = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    return index && typeof index.getAccountState === 'function'
      ? index.getAccountState(accountRef) || null
      : null;
  }

  function resolvePersistedOperationalStatus(accountRef) {
    const row = getIndexedAccountState(accountRef);
    return resolveEffectiveAccountStatus(row && row.status);
  }

  function extractActiveEnv(cliName) {
    if (!cliConfigs[cliName]) return null;
    const keys = cliConfigs[cliName].envKeys;
    const env = {};
    let hasKey = false;
    keys.forEach((k) => {
      if (process.env[k]) {
        env[k] = process.env[k];
        if (k.includes('API_KEY') || k.includes('ACCESS_TOKEN')) hasKey = true;
      }
    });
    return hasKey ? env : null;
  }

  function hashEnv(envObj) {
    return Buffer.from(JSON.stringify(envObj)).toString('base64');
  }

  function resolveAiHomeDir() {
    return String(aiHomeDir || '').trim();
  }

  function findEnvSandbox(cliName, targetEnv) {
    const targetHash = hashEnv(targetEnv);
    const credentialHomeDir = resolveAiHomeDir();
    if (!credentialHomeDir) return null;
    const records = listCliAccountCredentialRecords(fs, credentialHomeDir, cliName);
    for (const record of records) {
      if (record.env && hashEnv(record.env) === targetHash) return record.cliAccountId;
    }
    return null;
  }

  function isUsageManagedCli(cliName) {
    return cliName === 'codex' || cliName === 'claude' || cliName === 'gemini' || cliName === 'agy';
  }

  function getUsageRemainingPercentValues(cache) {
    if (!cache || typeof cache !== 'object') return [];
    if (cache.kind === 'gemini_oauth_stats' && Array.isArray(cache.models)) {
      return cache.models.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
    if (cache.kind === 'agy_code_assist_quota' && Array.isArray(cache.models)) {
      return cache.models.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
    if ((cache.kind === 'codex_oauth_status' || cache.kind === 'claude_oauth_usage') && Array.isArray(cache.entries)) {
      return cache.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
    return [];
  }

  function getAccountQuotaState(cliName, accountRef, options = {}) {
    const normalizedRef = String(accountRef || '').trim();
    if (!isAccountRef(normalizedRef)) return null;
    if (!hasAccountCredentials(fs, resolveAiHomeDir(), normalizedRef)) return null;
    const credentialRecord = readAccountCredentialRecord(fs, resolveAiHomeDir(), normalizedRef);
    if (!credentialRecord || credentialRecord.provider !== cliName) return null;
    const status = checkStatus(cliName, normalizedRef) || {};
    const configured = !!status.configured;
    const accountName = status && status.accountName ? String(status.accountName) : '';
    const env = credentialRecord.env || {};
    const apiKeyMode = Boolean(
      env.OPENAI_API_KEY
      || env.ANTHROPIC_API_KEY
      || env.ANTHROPIC_AUTH_TOKEN
      || env.GEMINI_API_KEY
      || env.GOOGLE_API_KEY
    );
    let cache = readUsageCache(cliName, normalizedRef);
    if (options.refreshSnapshot && configured && !apiKeyMode && isUsageManagedCli(cliName)) {
      cache = ensureUsageSnapshot(cliName, normalizedRef, cache);
    }
    const operationalStatus = resolvePersistedOperationalStatus(normalizedRef);
    const remainingPct = getMinRemainingPctFromCache(cache);
    const planType = String(cache && cache.account && cache.account.planType || '').trim().toLowerCase();
    const quotaState = deriveQuotaState({
      provider: cliName,
      configured,
      apiKeyMode,
      planType,
      remainingPct,
      usageSnapshot: cache
    });
    const schedulableState = deriveSchedulableState({
      provider: cliName,
      configured,
      apiKeyMode,
      accountStatus: operationalStatus,
      planType,
      remainingPct: quotaState.remainingPct,
      usageSnapshot: cache,
      quotaState
    });
    return {
      status: operationalStatus,
      configured,
      apiKeyMode,
      displayName: configured && !apiKeyMode && accountName !== 'Unknown' ? accountName : null,
      authMode: String(status.authMode || '').trim(),
      hasAccessToken: Boolean(status.hasAccessToken),
      hasRefreshToken: Boolean(status.hasRefreshToken),
      tokenExpiresAt: Number(status.tokenExpiresAt) || null,
      remainingPct: quotaState.remainingPct,
      quotaStatus: quotaState.status,
      quotaReason: quotaState.reason || '',
      schedulableStatus: schedulableState.status,
      schedulableReason: schedulableState.reason || ''
    };
  }

  function getMinRemainingPctFromCache(cache) {
    const values = getUsageRemainingPercentValues(cache);
    if (values.length === 0) return null;
    return Math.min(...values);
  }

  function refreshIndexedStateForAccount(cliName, accountRef, refreshAccountOptions = {}) {
    const normalizedRef = String(accountRef || '').trim();
    if (!isAccountRef(normalizedRef)) return null;
    const derivedState = getAccountQuotaState(cliName, normalizedRef, {
      refreshSnapshot: !!refreshAccountOptions.refreshSnapshot
    });
    if (!derivedState) return null;
    if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
      accountStateService.syncAccountBaseState(normalizedRef, cliName, {
        status: derivedState.status,
        configured: derivedState.configured,
        apiKeyMode: derivedState.apiKeyMode,
        authMode: derivedState.authMode,
        remainingPct: derivedState.remainingPct,
        displayName: derivedState.displayName
      });
    }
    clearRecoverableAgyAuthInvalidBlock({
      provider: cliName,
      accountRef: normalizedRef,
      runtimeStatus: deriveRuntimeStatus(getIndexedAccountState(normalizedRef)),
      authMetadata: derivedState,
      accountStateService,
      baseState: {
        status: derivedState.status,
        configured: derivedState.configured,
        apiKeyMode: derivedState.apiKeyMode,
        authMode: derivedState.authMode,
        displayName: derivedState.displayName,
        remainingPct: derivedState.remainingPct
      }
    });
    return derivedState;
  }

  function listStoredAccounts(cliName) {
    return listCliAccountCredentialRecords(fs, resolveAiHomeDir(), cliName);
  }

  function filterExistingAccountIds(cliName, ids) {
    const existingIds = new Set(listStoredAccounts(cliName).map((record) => record.cliAccountId));
    return (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter((id) => /^\d+$/.test(id) && existingIds.has(id))
      .sort((a, b) => Number(a) - Number(b));
  }

  function refreshAccountStateIndexForProvider(cliName, refreshOptions = {}) {
    const accounts = listStoredAccounts(cliName);
    const limit = Number(refreshOptions.limit);
    const max = Number.isFinite(limit) && limit > 0 ? Math.min(accounts.length, Math.floor(limit)) : accounts.length;
    for (let i = 0; i < max; i += 1) {
      refreshIndexedStateForAccount(cliName, accounts[i].accountRef, { refreshSnapshot: !!refreshOptions.refreshSnapshot });
    }
    return { provider: cliName, scanned: max, total: accounts.length };
  }

  function refreshStaleIndexedAccountStates(cliName, limit = usageIndexBgRefreshLimit) {
    const staleBefore = Date.now() - usageIndexStaleRefreshMs;
    const staleRefs = accountQueryService && typeof accountQueryService.listStaleAccountRefs === 'function'
      ? accountQueryService.listStaleAccountRefs(cliName, staleBefore, limit)
      : [];
    staleRefs.forEach((accountRef) => {
      refreshIndexedStateForAccount(cliName, accountRef, { refreshSnapshot: true });
    });
    return { provider: cliName, refreshed: staleRefs.length };
  }

  function ensureAccountUsageRefreshScheduler() {
    if (accountUsageRefreshScheduler) return accountUsageRefreshScheduler;
    const setIntervalUnref = (fn, ms) => {
      const timer = setInterval(fn, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    };
    accountUsageRefreshScheduler = createUsageScheduler({
      setIntervalFn: setIntervalUnref,
      refreshActiveAccount: () => {
        Object.keys(lastActiveAccountByCli).forEach((provider) => {
          const accountRef = String(lastActiveAccountByCli[provider] || '').trim();
          if (/^acct_[a-f0-9]{20}$/.test(accountRef)) {
            refreshIndexedStateForAccount(provider, accountRef, { refreshSnapshot: true });
          }
        });
      },
      refreshBackgroundAccounts: () => {
        Object.keys(cliConfigs).forEach((provider) => {
          refreshStaleIndexedAccountStates(provider, usageIndexBgRefreshLimit);
        });
      },
      logger: () => {}
    });
    accountUsageRefreshScheduler.start({
      activeRefreshIntervalMs: 60 * 1000,
      backgroundRefreshIntervalMs: 60 * 60 * 1000
    });
    return accountUsageRefreshScheduler;
  }

  function getToolAccountIds(cliName) {
    return listStoredAccounts(cliName)
      .map((record) => record.cliAccountId)
      .filter((id) => /^\d+$/.test(id))
      .sort((a, b) => Number(a) - Number(b));
  }

  return {
    extractActiveEnv,
    findEnvSandbox,
    getAccountQuotaState,
    getUsageRemainingPercentValues,
    getMinRemainingPctFromCache,
    refreshIndexedStateForAccount,
    filterExistingAccountIds,
    refreshAccountStateIndexForProvider,
    ensureAccountUsageRefreshScheduler,
    getToolAccountIds
  };
}

module.exports = {
  createUsageAccountRuntimeService
};
