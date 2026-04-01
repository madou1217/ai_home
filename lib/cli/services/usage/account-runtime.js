'use strict';

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

  function isExhausted(cliName, id) {
    const p = path.join(getProfileDir(cliName, id), '.aih_exhausted');
    if (fs.existsSync(p)) {
      let time = NaN;
      try {
        time = parseInt(fs.readFileSync(p, 'utf8'), 10);
      } catch (_error) {
        return false;
      }
      if (Number.isFinite(time) && Date.now() - time < 3600000) {
        return true;
      }
      try {
        fs.unlinkSync(p);
      } catch (_error) {}
    }
    return false;
  }

  function clearExhausted(cliName, id) {
    const p = path.join(getProfileDir(cliName, id), '.aih_exhausted');
    if (!fs.existsSync(p)) {
      stateIndexClient.setExhausted(cliName, id, false);
      return false;
    }
    try {
      fs.unlinkSync(p);
      stateIndexClient.setExhausted(cliName, id, false);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function markExhaustedFromUsage(cliName, id) {
    const p = path.join(getProfileDir(cliName, id), '.aih_exhausted');
    try {
      fs.writeFileSync(p, Date.now().toString());
      stateIndexClient.setExhausted(cliName, id, true);
      return true;
    } catch (_error) {
      return false;
    }
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

  function isUsageSnapshotExhausted(cache) {
    const values = getUsageRemainingPercentValues(cache);
    if (values.length === 0) return false;
    const minRemaining = Math.min(...values);
    return minRemaining <= 0;
  }

  function syncExhaustedStateFromUsage(cliName, id) {
    if (!isUsageManagedCli(cliName)) return null;
    const profileDir = getProfileDir(cliName, id);
    if (!fs.existsSync(profileDir)) return null;
    const { configured, accountName } = checkStatus(cliName, profileDir);
    if (!configured) return null;
    if (accountName && accountName.startsWith('API Key')) return null;

    let cache = readUsageCache(cliName, id);
    cache = ensureUsageSnapshot(cliName, id, cache);
    if (!cache) return null;

    if (isUsageSnapshotExhausted(cache)) {
      markExhaustedFromUsage(cliName, id);
      const values = getUsageRemainingPercentValues(cache);
      const minRemaining = values.length > 0 ? Math.min(...values) : null;
      stateIndexClient.upsert(cliName, id, {
        configured: true,
        apiKeyMode: false,
        exhausted: true,
        remainingPct: minRemaining
      });
      return true;
    }
    clearExhausted(cliName, id);
    const values = getUsageRemainingPercentValues(cache);
    const minRemaining = values.length > 0 ? Math.min(...values) : null;
    stateIndexClient.upsert(cliName, id, {
      configured: true,
      apiKeyMode: false,
      exhausted: false,
      remainingPct: minRemaining
    });
    return false;
  }

  function getMinRemainingPctFromCache(cache) {
    const values = getUsageRemainingPercentValues(cache);
    if (values.length === 0) return null;
    return Math.min(...values);
  }

  function refreshIndexedStateForAccount(cliName, id, refreshAccountOptions = {}) {
    const accountId = String(id || '').trim();
    if (!/^\d+$/.test(accountId)) return null;
    const profileDir = getProfileDir(cliName, accountId);
    if (!fs.existsSync(profileDir)) return null;
    const status = checkStatus(cliName, profileDir);
    const configured = !!(status && status.configured);
    const accountName = status && status.accountName ? String(status.accountName) : '';
    const apiKeyMode = !!(accountName && accountName.startsWith('API Key'));
    let cache = readUsageCache(cliName, accountId);
    if (refreshAccountOptions.refreshSnapshot && configured && !apiKeyMode) {
      cache = ensureUsageSnapshot(cliName, accountId, cache);
    }
    if (configured && !apiKeyMode && cache && isUsageManagedCli(cliName)) {
      if (isUsageSnapshotExhausted(cache)) {
        markExhaustedFromUsage(cliName, accountId);
      } else {
        clearExhausted(cliName, accountId);
      }
    }
    const exhausted = isExhausted(cliName, accountId);
    const remainingPct = getMinRemainingPctFromCache(cache);
    stateIndexClient.upsert(cliName, accountId, {
      configured,
      apiKeyMode,
      exhausted,
      remainingPct,
      displayName: configured && !apiKeyMode && accountName !== 'Unknown' ? accountName : null
    });
    return { configured, apiKeyMode, exhausted, remainingPct };
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
    isExhausted,
    clearExhausted,
    syncExhaustedStateFromUsage,
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
