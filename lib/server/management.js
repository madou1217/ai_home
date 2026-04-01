'use strict';
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function buildManagementStatusPayload(state, options) {
  const now = Date.now();
  const providers = {};
  let total = 0;
  let active = 0;
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const accounts = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
    const activeCount = accounts.filter((a) => now >= (a.cooldownUntil || 0)).length;
    providers[provider] = { total: accounts.length, active: activeCount };
    total += accounts.length;
    active += activeCount;
  });
  const cooldown = total - active;
  const requests = Math.max(1, state.metrics.totalRequests);
  const sessionAffinity = {};
  let stickyTotal = 0;
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const size = state.sessionAffinity && state.sessionAffinity[provider] instanceof Map
      ? state.sessionAffinity[provider].size
      : 0;
    sessionAffinity[provider] = size;
    stickyTotal += size;
  });
  const queue = {};
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const executor = state.executors && state.executors[provider];
    queue[provider] = executor && typeof executor.snapshot === 'function'
      ? executor.snapshot()
      : {
          name: provider,
          running: 0,
          queued: 0,
          maxConcurrency: 0,
          queueLimit: 0,
          totalScheduled: 0,
          totalRejected: 0
        };
  });
  return {
    ok: true,
    backend: options.backend,
    providerMode: options.provider,
    strategy: state.strategy,
    totalAccounts: total,
    activeAccounts: active,
    cooldownAccounts: cooldown,
    providers,
    sessionAffinity: { ...sessionAffinity, total: stickyTotal },
    queue,
    modelsCached: Array.isArray(state.modelsCache.ids) ? state.modelsCache.ids.length : 0,
    modelsUpdatedAt: state.modelsCache.updatedAt || 0,
    modelRegistryUpdatedAt: state.modelRegistry.updatedAt || 0,
    successRate: Number((state.metrics.totalSuccess / requests).toFixed(4)),
    timeoutRate: Number((state.metrics.totalTimeouts / requests).toFixed(4)),
    totalRequests: state.metrics.totalRequests,
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000)
  };
}

function buildManagementMetricsPayload(state) {
  const requests = Math.max(1, state.metrics.totalRequests);
  return {
    ok: true,
    totalRequests: state.metrics.totalRequests,
    totalSuccess: state.metrics.totalSuccess,
    totalFailures: state.metrics.totalFailures,
    totalTimeouts: state.metrics.totalTimeouts,
    successRate: Number((state.metrics.totalSuccess / requests).toFixed(4)),
    timeoutRate: Number((state.metrics.totalTimeouts / requests).toFixed(4)),
    routeCounts: state.metrics.routeCounts,
    providerCounts: state.metrics.providerCounts,
    providerSuccess: state.metrics.providerSuccess,
    providerFailures: state.metrics.providerFailures,
    queue: SUPPORTED_SERVER_PROVIDERS.reduce((acc, provider) => {
      const executor = state.executors && state.executors[provider];
      acc[provider] = executor && typeof executor.snapshot === 'function'
        ? executor.snapshot()
        : {
            name: provider,
            running: 0,
            queued: 0,
            maxConcurrency: 0,
            queueLimit: 0,
            totalScheduled: 0,
            totalRejected: 0
          };
      return acc;
    }, {}),
    lastErrors: state.metrics.lastErrors
  };
}

function buildManagementAccountsPayload(state) {
  const allAccounts = SUPPORTED_SERVER_PROVIDERS
    .flatMap((provider) => (state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : []));
  return {
    ok: true,
    accounts: allAccounts.map((a) => ({
      id: a.id,
      provider: a.provider || 'codex',
      email: a.email,
      accountId: a.accountId,
      remainingPct: Number.isFinite(Number(a.remainingPct)) ? Number(a.remainingPct) : null,
      hasAccessToken: !!a.accessToken,
      hasRefreshToken: !!a.refreshToken,
      cooldownUntil: a.cooldownUntil || 0,
      lastRefresh: a.lastRefresh,
      consecutiveFailures: a.consecutiveFailures || 0,
      successCount: a.successCount || 0,
      failCount: a.failCount || 0,
      lastError: a.lastError || ''
    }))
  };
}

function applyReloadState(state, runtimeAccounts) {
  state.accounts = runtimeAccounts;
  state.cursors = SUPPORTED_SERVER_PROVIDERS.reduce((acc, provider) => {
    acc[provider] = 0;
    return acc;
  }, {});
  if (state.sessionAffinity && typeof state.sessionAffinity === 'object') {
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      state.sessionAffinity[provider] = new Map();
    });
  }
  state.modelsCache = {
    updatedAt: 0,
    ids: [],
    byAccount: {},
    sourceCount: 0
  };
}

module.exports = {
  buildManagementStatusPayload,
  buildManagementMetricsPayload,
  buildManagementAccountsPayload,
  applyReloadState
};
