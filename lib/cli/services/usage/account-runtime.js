'use strict';

const {
  readAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../../../account/status-file');
const {
  deriveQuotaState,
  deriveSchedulableState
} = require('../../../account/derived-state');

function createUsageAccountRuntimeService(options = {}) {
  const {
    path,
    fs,
    profilesDir,
    cliConfigs,
    createUsageScheduler,
    getAccountStateIndex,
    stateIndexClient,
    lastActiveAccountByCli,
    usageIndexStaleRefreshMs,
    usageIndexBgRefreshLimit,
    getProfileDir,
    checkStatus,
    readUsageCache,
    ensureUsageSnapshot
  } = options;

  let accountUsageRefreshScheduler = null;

  function getIndexedAccountState(cliName, accountId) {
    const index = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    if (!index) return null;
    if (typeof index.getAccountState === 'function') {
      return index.getAccountState(cliName, accountId) || null;
    }
    if (typeof index.listStates === 'function') {
      const rows = index.listStates(cliName) || [];
      return rows.find((row) => String(row && row.accountId || '') === String(accountId)) || null;
    }
    return null;
  }

  function resolvePersistedOperationalStatus(cliName, accountId) {
    const row = getIndexedAccountState(cliName, accountId);
    return resolveEffectiveAccountStatus(
      row && row.status,
      readAccountStatusFile(fs, getProfileDir(cliName, accountId))
    );
  }

  function extractActiveEnv(cliName) {
    if (!cliConfigs[cliName]) return null;
    const keys = cliConfigs[cliName].envKeys;
    const env = {};
    let hasKey = false;
    keys.forEach((k) => {
      if (process.env[k]) {
        env[k] = process.env[k];
        if (k.includes('API_KEY')) hasKey = true;
      }
    });
    return hasKey ? env : null;
  }

  function hashEnv(envObj) {
    return Buffer.from(JSON.stringify(envObj)).toString('base64');
  }

  function findEnvSandbox(cliName, targetEnv) {
    const targetHash = hashEnv(targetEnv);
    const toolDir = path.join(profilesDir, cliName);
    if (!fs.existsSync(toolDir)) return null;
    const ids = fs.readdirSync(toolDir).filter((f) => /^\d+$/.test(f));
    for (const id of ids) {
      const p = path.join(toolDir, id, '.aih_env.json');
      if (fs.existsSync(p)) {
        try {
          const savedEnv = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (hashEnv(savedEnv) === targetHash) return id;
        } catch (_error) {}
      }
    }
    return null;
  }

  function isUsageManagedCli(cliName) {
    return cliName === 'codex' || cliName === 'claude';
  }

  function getUsageRemainingPercentValues(cache) {
    if (!cache || typeof cache !== 'object') return [];
    if (cache.kind === 'gemini_oauth_stats' && Array.isArray(cache.models)) {
      return cache.models.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
    if ((cache.kind === 'codex_oauth_status' || cache.kind === 'claude_oauth_usage') && Array.isArray(cache.entries)) {
      return cache.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
    return [];
  }

  function getAccountQuotaState(cliName, accountId, options = {}) {
    const normalizedId = String(accountId || '').trim();
    if (!/^\d+$/.test(normalizedId)) return null;
    const profileDir = getProfileDir(cliName, normalizedId);
    if (!fs.existsSync(profileDir)) return null;
    const status = checkStatus(cliName, profileDir) || {};
    const configured = !!status.configured;
    const accountName = status && status.accountName ? String(status.accountName) : '';
    const apiKeyMode = !!(accountName && accountName.startsWith('API Key'));
    let cache = readUsageCache(cliName, normalizedId);
    if (options.refreshSnapshot && configured && !apiKeyMode && isUsageManagedCli(cliName)) {
      cache = ensureUsageSnapshot(cliName, normalizedId, cache);
    }
    const operationalStatus = resolvePersistedOperationalStatus(cliName, normalizedId);
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

  function refreshIndexedStateForAccount(cliName, id, refreshAccountOptions = {}) {
    const accountId = String(id || '').trim();
    if (!/^\d+$/.test(accountId)) return null;
    const derivedState = getAccountQuotaState(cliName, accountId, {
      refreshSnapshot: !!refreshAccountOptions.refreshSnapshot
    });
    if (!derivedState) return null;
    stateIndexClient.upsert(cliName, accountId, {
      status: derivedState.status,
      configured: derivedState.configured,
      apiKeyMode: derivedState.apiKeyMode,
      remainingPct: derivedState.remainingPct,
      displayName: derivedState.displayName
    });
    return derivedState;
  }

  function listToolProfileIdsFromFs(cliName) {
    const toolDir = path.join(profilesDir, cliName);
    if (!fs.existsSync(toolDir)) return [];
    return fs.readdirSync(toolDir)
      .filter((f) => /^\d+$/.test(f) && fs.statSync(path.join(toolDir, f)).isDirectory())
      .sort((a, b) => Number(a) - Number(b));
  }

  function filterExistingAccountIds(cliName, ids) {
    return (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter((id) => /^\d+$/.test(id) && fs.existsSync(getProfileDir(cliName, id)))
      .sort((a, b) => Number(a) - Number(b));
  }

  function refreshAccountStateIndexForProvider(cliName, refreshOptions = {}) {
    const ids = listToolProfileIdsFromFs(cliName);
    const limit = Number(refreshOptions.limit);
    const max = Number.isFinite(limit) && limit > 0 ? Math.min(ids.length, Math.floor(limit)) : ids.length;
    for (let i = 0; i < max; i += 1) {
      refreshIndexedStateForAccount(cliName, ids[i], { refreshSnapshot: !!refreshOptions.refreshSnapshot });
    }
    return { provider: cliName, scanned: max, total: ids.length };
  }

  function refreshStaleIndexedAccountStates(cliName, limit = usageIndexBgRefreshLimit) {
    const staleBefore = Date.now() - usageIndexStaleRefreshMs;
    const staleIds = getAccountStateIndex().listStaleIds(cliName, staleBefore, limit);
    staleIds.forEach((id) => {
      refreshIndexedStateForAccount(cliName, id, { refreshSnapshot: true });
    });
    return { provider: cliName, refreshed: staleIds.length };
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
          refreshIndexedStateForAccount(provider, lastActiveAccountByCli[provider], { refreshSnapshot: true });
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
    const fsIds = listToolProfileIdsFromFs(cliName);
    stateIndexClient.pruneMissing(cliName, fsIds);
    return fsIds;
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
