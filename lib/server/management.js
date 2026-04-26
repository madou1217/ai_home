'use strict';
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { invalidateWebUiModelsCache } = require('./webui-model-cache');
const { readTrustedUsageSnapshot } = require('./accounts');
const { normalizeAccountUsageSnapshot } = require('./account-usage-view');
const {
  resolvePreferredRemainingPct,
  deriveQuotaState,
  deriveSchedulableState
} = require('../account/derived-state');

function buildManagementStatusPayload(state, options) {
  const now = Date.now();
  const providers = {};
  let total = 0;
  let active = 0;
  const statusTotals = {
    healthy: 0,
    rate_limited: 0,
    auth_invalid: 0,
    overloaded: 0,
    transient_network: 0,
    service_unavailable: 0,
    upstream_error: 0,
    cooling_down: 0,
    unknown: 0
  };
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const accounts = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
    const activeCount = accounts.filter((a) => deriveAccountRuntimeStatus(a, now).status === 'healthy').length;
    const statuses = accounts.reduce((acc, account) => {
      const runtime = deriveAccountRuntimeStatus(account, now);
      const key = runtime.status || 'unknown';
      acc[key] = Number(acc[key] || 0) + 1;
      statusTotals[key] = Number(statusTotals[key] || 0) + 1;
      return acc;
    }, {});
    providers[provider] = { total: accounts.length, active: activeCount, statuses };
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
    host: String(options.host || '127.0.0.1'),
    port: Number(options.port || 8317),
    apiKeyConfigured: Boolean(options.clientKey),
    providerMode: options.provider,
    strategy: state.strategy,
    totalAccounts: total,
    activeAccounts: active,
    cooldownAccounts: cooldown,
    statusTotals,
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

function buildManagementAccountsPayload(state, deps = {}) {
  const { fs, getProfileDir } = deps;
  const allAccounts = SUPPORTED_SERVER_PROVIDERS
    .flatMap((provider) => (state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : []));
  return {
    ok: true,
    accounts: allAccounts.map((a) => {
      const runtime = deriveAccountRuntimeStatus(a);
      const provider = a.provider || 'codex';
      const apiKeyMode = Boolean(a.apiKeyMode || a.authType === 'api-key');
      const trustedSnapshot = fs && typeof getProfileDir === 'function'
        ? readTrustedUsageSnapshot({ fs, getProfileDir }, provider, a.id)
        : null;
      const normalizedSnapshot = normalizeAccountUsageSnapshot(trustedSnapshot);
      const rawRemaining = a && a.remainingPct;
      const runtimeRemaining = rawRemaining !== null && rawRemaining !== undefined && rawRemaining !== ''
        ? Number(rawRemaining)
        : null;
      const status = String(a.status || 'up').trim().toLowerCase() === 'down' ? 'down' : 'up';
      const planType = apiKeyMode ? 'api-key' : String(trustedSnapshot && trustedSnapshot.account && trustedSnapshot.account.planType || '').trim();
      const remainingPct = resolvePreferredRemainingPct(
        trustedSnapshot,
        runtimeRemaining
      );
      const quotaState = deriveQuotaState({
        provider,
        configured: true,
        apiKeyMode,
        planType,
        remainingPct,
        usageSnapshot: trustedSnapshot
      });
      const schedulableState = deriveSchedulableState({
        provider,
        configured: true,
        apiKeyMode,
        accountStatus: status,
        runtimeStatus: runtime.status,
        planType,
        remainingPct,
        usageSnapshot: trustedSnapshot,
        quotaState
      });
      return {
        runtimeStatus: runtime.status,
        runtimeUntil: runtime.until,
        runtimeReason: runtime.reason,
        id: a.id,
        provider,
        status,
        email: a.email,
        accountId: a.accountId,
        baseUrl: a.baseUrl || a.openaiBaseUrl || '',
        planType,
        configured: true,
        apiKeyMode,
        remainingPct,
        usageSnapshot: normalizedSnapshot,
        quotaStatus: quotaState.status,
        quotaReason: quotaState.reason || '',
        schedulableStatus: schedulableState.status,
        schedulableReason: schedulableState.reason || '',
        hasAccessToken: !!a.accessToken,
        hasRefreshToken: !!a.refreshToken,
        cooldownUntil: a.cooldownUntil || 0,
        lastRefresh: a.lastRefresh,
        consecutiveFailures: a.consecutiveFailures || 0,
        successCount: a.successCount || 0,
        failCount: a.failCount || 0,
        lastError: a.lastError || ''
      };
    })
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
  invalidateWebUiModelsCache(state);
}

module.exports = {
  buildManagementStatusPayload,
  buildManagementMetricsPayload,
  buildManagementAccountsPayload,
  applyReloadState
};
