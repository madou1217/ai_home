'use strict';
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  deriveEffectiveRuntimeStatus,
  isBlockingRuntimeStatus
} = require('../account/runtime-view');
const { normalizeAccountRuntime } = require('./account-runtime-state');
const { invalidateWebUiModelsCache } = require('./webui-model-cache');
const { rebindModelAccountIndexAccounts } = require('./model-account-index');
const {
  readTrustedUsageSnapshot,
  readUsageThresholdPct
} = require('./accounts');
const { normalizeAccountUsageSnapshot } = require('./account-usage-view');
const { buildAgyEffectiveUsageView } = require('./agy-account-usage-view');
const {
  resolvePreferredRemainingPct,
  deriveQuotaState,
  deriveSchedulableState
} = require('../account/derived-state');
const { DEFAULT_SERVER_PORT } = require('./server-defaults');
const { getApiKeyDisplayName, getBaseDomain, cleanOauthDisplayName } = require('./account-display-identity');

function readEffectiveRuntimeState(account, stateInfo) {
  if (stateInfo && Object.prototype.hasOwnProperty.call(stateInfo, 'runtimeState')) return stateInfo.runtimeState;
  return account;
}

function buildActiveModelCooldowns(runtimeState, nowMs = Date.now()) {
  const normalized = runtimeState && typeof runtimeState === 'object'
    ? normalizeAccountRuntime({ ...runtimeState })
    : null;
  const map = normalized && normalized.modelCooldowns;
  if (!map || typeof map !== 'object') return {};
  return Object.keys(map).sort().reduce((acc, model) => {
    const until = Number(map[model]);
    if (Number.isFinite(until) && until > nowMs) acc[model] = until;
    return acc;
  }, {});
}

function buildManagementStatusPayload(state, options, deps = {}) {
  const { accountStateIndex } = deps;
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
    const activeCount = accounts.filter((a) => {
      const stateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
        ? accountStateIndex.getAccountState(a.accountRef)
        : null;
      return deriveEffectiveRuntimeStatus(a, stateInfo, now).status === 'healthy';
    }).length;
    const statuses = accounts.reduce((acc, account) => {
      const stateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
        ? accountStateIndex.getAccountState(account.accountRef)
        : null;
      const runtime = deriveEffectiveRuntimeStatus(account, stateInfo, now);
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
    port: Number(options.port || DEFAULT_SERVER_PORT),
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
    lastErrors: normalizeMetricErrors(state.metrics.lastErrors, state.accounts)
  };
}

function resolveFriendlyAccountLabel(account, provider, index) {
  if (!account) return '';
  const prov = String(provider || account.provider || '').trim().toLowerCase();
  const provName = prov ? prov.toUpperCase() : 'AI';
  if (account.email) return String(account.email).trim();
  const cleanedDisplay = cleanOauthDisplayName(account.displayName);
  if (cleanedDisplay) return cleanedDisplay;
  const isApiKey = Boolean(account.apiKeyMode || account.authType === 'api-key');
  const baseUrl = account.baseUrl || account.openaiBaseUrl || account.anthropicBaseUrl || account.kimiBaseUrl || '';
  if (isApiKey) {
    const domain = getBaseDomain(baseUrl);
    if (domain) return `${provName} (${domain})`;
    return `${provName} 密钥账号`;
  }
  if (typeof index === 'number' && index >= 0) {
    return `${provName} 账号 #${index + 1}`;
  }
  return `${provName} 账号`;
}

function normalizeMetricErrors(errors, accountsMap = {}) {
  const allAccountsByProvider = {};
  const allAccountsByRef = new Map();
  if (accountsMap && typeof accountsMap === 'object') {
    Object.entries(accountsMap).forEach(([prov, list]) => {
      if (!Array.isArray(list)) return;
      allAccountsByProvider[prov] = list;
      list.forEach((acc, idx) => {
        if (acc && acc.accountRef) {
          allAccountsByRef.set(String(acc.accountRef), { account: acc, provider: prov, index: idx });
        }
      });
    });
  }

  return (Array.isArray(errors) ? errors : []).map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const publicItem = { ...source };
    ['account' + 'Key', 'account_key', 'accountId', 'account_id', 'aiHomeAccountId'].forEach((field) => {
      delete publicItem[field];
    });
    const message = String(
      (source.message || source.error || source.detail || source.reason)
      || ''
    );
    const provider = String(source.provider || '').trim().toLowerCase();
    const rawAccountRef = String(source.accountRef || '').trim();
    let accountLabel = source.accountLabel || '';
    if (!accountLabel && rawAccountRef && allAccountsByRef.has(rawAccountRef)) {
      const match = allAccountsByRef.get(rawAccountRef);
      accountLabel = resolveFriendlyAccountLabel(match.account, match.provider, match.index);
    }
    const attemptedRefs = Array.isArray(source.attemptedAccountRefs) ? source.attemptedAccountRefs : [];
    delete publicItem.attemptedAccountRefs;

    return {
      ...publicItem,
      provider,
      accountRef: rawAccountRef,
      accountLabel: accountLabel || (attemptedRefs.length > 1 ? `尝试了 ${attemptedRefs.length} 个账号` : (source.accountLabel || '')),
      attemptedCount: attemptedRefs.length > 0 ? attemptedRefs.length : undefined,
      sessionId: source.sessionId || source.sessionKey || undefined,
      projectPath: source.projectPath || undefined,
      projectDirName: source.projectDirName || undefined,
      model: source.model || undefined,
      requestedModel: source.requestedModel || undefined,
      effectiveModel: source.effectiveModel || undefined,
      clientProtocol: source.clientProtocol || undefined,
      familyProvider: source.familyProvider || undefined,
      effectiveProvider: source.effectiveProvider || undefined,
      aliasTarget: source.aliasTarget || undefined,
      aliasMatched: source.aliasMatched !== undefined ? Boolean(source.aliasMatched) : undefined,
      message,
      error: String(source.error || message)
    };
  });
}

function buildManagementAccountsPayload(state, deps = {}) {
  const { fs, aiHomeDir, accountStateIndex } = deps;
  const usageThresholdPct = readUsageThresholdPct({ fs, aiHomeDir });
  const allAccounts = SUPPORTED_SERVER_PROVIDERS
    .flatMap((provider) => (state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : []));
  return {
    ok: true,
    accounts: allAccounts.map((a) => {
      const provider = a.provider || 'codex';
      const stateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
        ? accountStateIndex.getAccountState(a.accountRef)
        : null;
      const runtime = deriveEffectiveRuntimeStatus(a, stateInfo);
      const runtimeState = readEffectiveRuntimeState(a, stateInfo);
      const apiKeyMode = Boolean(a.apiKeyMode || a.authType === 'api-key');
      const trustedSnapshot = fs && aiHomeDir && a.accountRef
        ? readTrustedUsageSnapshot({ fs, aiHomeDir }, provider, a.accountRef)
        : null;
      const agyUsageView = provider === 'agy' && !apiKeyMode
        ? buildAgyEffectiveUsageView({
            usageSnapshot: trustedSnapshot,
            runtimeState,
            account: a
          })
        : null;
      const effectiveSnapshot = agyUsageView
        ? agyUsageView.usageSnapshot
        : trustedSnapshot;
      const normalizedSnapshot = normalizeAccountUsageSnapshot(effectiveSnapshot);
      const modelCooldowns = agyUsageView
        ? agyUsageView.activeModelCooldowns
        : buildActiveModelCooldowns(runtimeState);
      const rawRemaining = a && a.remainingPct;
      const runtimeRemaining = rawRemaining !== null && rawRemaining !== undefined && rawRemaining !== ''
        ? Number(rawRemaining)
        : null;
      const status = String(a.status || 'up').trim().toLowerCase() === 'down' ? 'down' : 'up';
      const planType = apiKeyMode
        ? 'api-key'
        : (
            agyUsageView
              ? agyUsageView.planType
              : String(trustedSnapshot && trustedSnapshot.account && trustedSnapshot.account.planType || '').trim()
          );
      const remainingPct = agyUsageView
        ? agyUsageView.remainingPct
        : resolvePreferredRemainingPct(
            effectiveSnapshot,
            runtimeRemaining
          );
      const visibleRemainingPct = isBlockingRuntimeStatus(runtime) ? null : remainingPct;
      const quotaState = deriveQuotaState({
        provider,
        configured: true,
        apiKeyMode,
        planType,
        remainingPct: visibleRemainingPct,
        usageSnapshot: effectiveSnapshot
      });
      const schedulableState = deriveSchedulableState({
        provider,
        configured: true,
        apiKeyMode,
        accountStatus: status,
        runtimeStatus: runtime.status,
        planType,
        remainingPct: visibleRemainingPct,
        usageSnapshot: effectiveSnapshot,
        quotaState,
        usageThresholdPct
      });
      return {
        runtimeStatus: runtime.status,
        runtimeUntil: runtime.until,
        runtimeReason: runtime.reason,
        accountRef: a.accountRef || '',
        provider,
        status,
        email: a.email,
        baseUrl: a.baseUrl || a.openaiBaseUrl || '',
        planType,
        configured: true,
        apiKeyMode,
        remainingPct: visibleRemainingPct,
        usageSnapshot: normalizedSnapshot,
        quotaStatus: quotaState.status,
        quotaReason: quotaState.reason || '',
        schedulableStatus: schedulableState.status,
        schedulableReason: schedulableState.reason || '',
        hasAccessToken: !!a.accessToken,
        hasRefreshToken: !!a.refreshToken,
        cooldownUntil: a.cooldownUntil || 0,
        modelCooldowns,
        modelCooldownCount: Object.keys(modelCooldowns).length,
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
  // 替换 state.accounts 必须同步重绑派生索引，否则别名预检会读到冻结的冷却状态。
  rebindModelAccountIndexAccounts(state.modelAccountIndex, state);
  state.cursors = SUPPORTED_SERVER_PROVIDERS.reduce((acc, provider) => {
    acc[provider] = 0;
    return acc;
  }, {});
  if (state.sessionAffinity && typeof state.sessionAffinity === 'object') {
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      state.sessionAffinity[provider] = new Map();
    });
  }
  if (state.geminiSessionIdMap instanceof Map) {
    state.geminiSessionIdMap.clear();
  }
  state.modelsCache = {
    updatedAt: 0,
    ids: [],
    byAccount: {},
    catalogByAccount: {},
    sourceCount: 0,
    scannedAccounts: 0,
    firstError: '',
    source: 'empty',
    signature: ''
  };
  // 账号还在，它的模型目录就还作数：账号重载只该丢掉「已经消失的账号」的目录，
  // 不该把所有账号的目录一起清空。整体清空会让重载后的第一次探测决定一切——
  // 那次探测一旦超时/失败，账号模型页就变成「可见模型 N、列表却是空的」，
  // 而且要等下一次成功探测才恢复。目录只应由一次成功的模型列表请求来刷新。
  invalidateWebUiModelsCacheKeepingAccountCatalogs(state);
}

/**
 * 重载后必须重新探测（账号集合变了，signature/byProvider 都不再作数），
 * 但仍然存在的账号的**逐账号目录**要留着：它只应由一次成功的模型列表请求来刷新。
 * 全清的话，重载后第一次探测一旦超时/失败，账号模型页就会变成
 * 「可见模型 N、列表却是空的」，还得等下一次成功探测才恢复。
 */
function invalidateWebUiModelsCacheKeepingAccountCatalogs(state) {
  const previous = (state && state.webUiModelsCache) || {};
  const previousByAccount = previous.byAccount && typeof previous.byAccount === 'object'
    ? previous.byAccount
    : {};
  const liveRefs = new Set();
  Object.values((state && state.accounts) || {}).forEach((accounts) => {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      const accountRef = String((account && account.accountRef) || '').trim();
      if (accountRef) liveRefs.add(accountRef);
    });
  });

  const carriedByAccount = {};
  Object.entries(previousByAccount).forEach(([accountRef, models]) => {
    // 账号没了就连目录一起丢；还在就留着，等下一次成功探测来刷新。
    if (liveRefs.has(accountRef) && Array.isArray(models) && models.length > 0) {
      carriedByAccount[accountRef] = models.slice();
    }
  });

  const nextCache = invalidateWebUiModelsCache(state);
  nextCache.byAccount = carriedByAccount;
  state.webUiModelsCache = nextCache;
  return nextCache;
}

module.exports = {
  buildManagementStatusPayload,
  buildManagementMetricsPayload,
  normalizeMetricErrors,
  buildManagementAccountsPayload,
  applyReloadState
};
