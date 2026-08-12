'use strict';

const {
  discoverProviderModels,
  buildModelDiscoverySignature,
  accountMatchesScope,
  listAccountModelCacheRefs
} = require('./provider-model-discovery');
const {
  readCacheJson,
  writeCacheJson
} = require('./webui-cache-store');
const { recoverProbedAccounts } = require('./account-probe-recovery');

// WebUI 普通读取应稳定返回缓存；上游变化由显式刷新负责。
const WEBUI_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const WEBUI_MODELS_CACHE_FILE = 'webui-models-snapshot.json';

function initWebUiModelsCache() {
  return {
    updatedAt: 0,
    byProvider: {},
    byAccount: {},
    errorsByAccount: {},
    accountUpdatedAt: {},
    accountSource: {},
    accountScanned: {},
    labels: {},
    signature: '',
    source: 'empty',
    sourceCount: 0,
    scannedAccounts: 0,
    firstError: ''
  };
}

function cloneByProvider(byProvider) {
  const source = byProvider && typeof byProvider === 'object' ? byProvider : {};
  const out = {};
  Object.entries(source).forEach(([provider, models]) => {
    out[provider] = Array.isArray(models) ? models.slice() : [];
  });
  return out;
}

// 空目录一律不落地：它不携带任何信息，却会被读成「这个账号已知没有任何模型」。
// 一次探测超时写下的空条目会跟着快照一路续命到重启之后，页面表现为
// 「可见模型 N、列表空白」，重新探测也顶不掉。没有条目 = 未知，才是对的表达。
function cloneByAccount(byAccount) {
  const source = byAccount && typeof byAccount === 'object' ? byAccount : {};
  const out = {};
  Object.entries(source).forEach(([accountRef, models]) => {
    if (Array.isArray(models) && models.length > 0) out[accountRef] = models.slice();
  });
  return out;
}

function cloneErrorsByAccount(errorsByAccount) {
  const source = errorsByAccount && typeof errorsByAccount === 'object' ? errorsByAccount : {};
  const out = {};
  Object.entries(source).forEach(([accountRef, message]) => {
    out[accountRef] = String(message || '');
  });
  return out;
}

function cloneAccountUpdatedAt(accountUpdatedAt) {
  const source = accountUpdatedAt && typeof accountUpdatedAt === 'object' ? accountUpdatedAt : {};
  const out = {};
  Object.entries(source).forEach(([accountRef, timestamp]) => {
    const value = Number(timestamp || 0);
    if (Number.isFinite(value) && value > 0) out[accountRef] = value;
  });
  return out;
}

function cloneAccountSource(accountSource) {
  const source = accountSource && typeof accountSource === 'object' ? accountSource : {};
  const out = {};
  Object.entries(source).forEach(([accountRef, value]) => {
    const normalized = String(value || '').trim();
    if (normalized) out[accountRef] = normalized;
  });
  return out;
}

function cloneAccountScanned(accountScanned) {
  const source = accountScanned && typeof accountScanned === 'object' ? accountScanned : {};
  const out = {};
  Object.entries(source).forEach(([accountRef, value]) => {
    const normalized = Number(value || 0);
    if (Number.isFinite(normalized) && normalized > 0) out[accountRef] = normalized;
  });
  return out;
}

// 上游 displayName 与模型 id 可能完全错位(如 gemini-3-flash-agent 显示为
// "Gemini 3.5 Flash (High)"),必须把显示名透出给前端,否则用户对不上号。
function collectModelDisplayLabels(state) {
  const labels = {};
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  Object.entries(accountsByProvider).forEach(([provider, accounts]) => {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      const descriptors = Array.isArray(account && account.codeAssistModelDescriptors)
        ? account.codeAssistModelDescriptors
        : [];
      descriptors.forEach((descriptor) => {
        const id = String(descriptor && descriptor.id || '').trim();
        const displayName = String(descriptor && descriptor.displayName || '').trim();
        if (!id || !displayName || displayName === id) return;
        if (!labels[provider]) labels[provider] = {};
        if (!labels[provider][id]) labels[provider][id] = displayName;
      });
    });
  });
  return labels;
}

function cloneModelLabels(labels) {
  const source = labels && typeof labels === 'object' ? labels : {};
  const out = {};
  Object.entries(source).forEach(([provider, byModel]) => {
    out[provider] = { ...(byModel && typeof byModel === 'object' ? byModel : {}) };
  });
  return out;
}

function normalizeWebUiModelsCache(cache) {
  const source = cache && typeof cache === 'object' ? cache : {};
  return {
    updatedAt: Number(source.updatedAt || 0) || 0,
    byProvider: cloneByProvider(source.byProvider),
    byAccount: cloneByAccount(source.byAccount),
    errorsByAccount: cloneErrorsByAccount(source.errorsByAccount),
    accountUpdatedAt: cloneAccountUpdatedAt(source.accountUpdatedAt),
    accountSource: cloneAccountSource(source.accountSource),
    accountScanned: cloneAccountScanned(source.accountScanned),
    labels: cloneModelLabels(source.labels),
    signature: String(source.signature || ''),
    source: String(source.source || 'empty'),
    sourceCount: Number(source.sourceCount || 0),
    scannedAccounts: Number(source.scannedAccounts || 0),
    firstError: String(source.firstError || '')
  };
}

function readPersistedWebUiModelsCache(deps = {}) {
  return normalizeWebUiModelsCache(readCacheJson(deps, WEBUI_MODELS_CACHE_FILE));
}

function writePersistedWebUiModelsCache(deps = {}, cache) {
  writeCacheJson(deps, WEBUI_MODELS_CACHE_FILE, normalizeWebUiModelsCache(cache));
}

function ensureWebUiModelsCacheLoaded(state, deps = {}) {
  if (!state) return initWebUiModelsCache();
  const current = normalizeWebUiModelsCache(state.webUiModelsCache);
  const persisted = readPersistedWebUiModelsCache(deps);
  if (persisted.updatedAt > current.updatedAt) {
    state.webUiModelsCache = persisted;
    return state.webUiModelsCache;
  }
  state.webUiModelsCache = current.updatedAt > 0 ? current : persisted;
  return state.webUiModelsCache;
}

function listCurrentAccountCacheRefs(state, accountScope = null) {
  const refs = new Set();
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  Object.entries(accountsByProvider).forEach(([provider, accounts]) => {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      if (!accountMatchesScope(provider, account, accountScope)) return;
      listAccountModelCacheRefs(provider, account).forEach((accountRef) => refs.add(accountRef));
    });
  });
  return refs;
}

function mergeByAccountCache(previous, next, errorsByAccount, refreshedAccountRefs) {
  const out = {};
  const refs = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(next || {})
  ]);
  refreshedAccountRefs.forEach((accountRef) => refs.add(accountRef));
  refs.forEach((accountRef) => {
    const hasNext = Object.prototype.hasOwnProperty.call(next, accountRef);
    const hasPrevious = Object.prototype.hasOwnProperty.call(previous, accountRef);
    if (!hasNext && hasPrevious) {
      // 本轮没探测这个账号：带上旧目录。但空目录不带——它不携带任何信息，
      // 带下去只会让「已知为空」这个错误状态永远续命（页面列不出模型，
      // 下游还会当成这个账号确实不支持任何模型）。留空即「未知」。
      const carried = Array.isArray(previous[accountRef]) ? previous[accountRef] : [];
      if (carried.length > 0) out[accountRef] = carried.slice();
      return;
    }
    if (!hasNext) return;
    const nextModels = Array.isArray(next[accountRef]) ? next[accountRef] : [];
    const previousModels = Array.isArray(previous[accountRef]) ? previous[accountRef] : [];
    const probeFailed = Boolean(errorsByAccount[accountRef]);
    if (nextModels.length > 0 || !probeFailed) {
      // 只有成功拿到模型列表才刷新缓存——包括「成功但确实为空」这种合法结果。
      out[accountRef] = nextModels.slice();
      return;
    }
    // 探测失败：绝不能把已知目录换成空。有旧目录就留旧目录；
    // 连旧目录都没有时，整条 ref 不写入——「未知」和「已知为空」是两回事，
    // 写成 []=已知为空 会让页面显示成「可见模型 N、列表却是空的」，
    // 也会让下游按模型选账号时把这个账号判成「确实不支持任何模型」。
    if (previousModels.length > 0) {
      out[accountRef] = previousModels.slice();
    }
  });
  return out;
}

function mergeErrorsByAccount(previous, next, nextByAccount, refreshedAccountRefs) {
  const out = {};
  const refs = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(next || {})
  ]);
  refreshedAccountRefs.forEach((accountRef) => refs.add(accountRef));
  refs.forEach((accountRef) => {
    if (Object.prototype.hasOwnProperty.call(next, accountRef)) {
      out[accountRef] = String(next[accountRef] || '');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(nextByAccount, accountRef)) return;
    if (Object.prototype.hasOwnProperty.call(previous, accountRef)) {
      out[accountRef] = String(previous[accountRef] || '');
    }
  });
  return out;
}

function mergeByProviderCache(previous, next, firstError, accountScope = null) {
  if (accountScope) {
    const out = cloneByProvider(previous);
    Object.entries(cloneByProvider(next)).forEach(([provider, models]) => {
      if (models.length < 1) return;
      out[provider] = Array.from(new Set([...(out[provider] || []), ...models])).sort();
    });
    return out;
  }
  const out = cloneByProvider(next);
  Object.entries(cloneByProvider(previous)).forEach(([provider, models]) => {
    if (Array.isArray(out[provider]) && out[provider].length > 0) return;
    if (!firstError || models.length < 1) return;
    out[provider] = models.slice();
  });
  return out;
}

function mergeModelLabels(previous, next) {
  const out = cloneModelLabels(previous);
  Object.entries(cloneModelLabels(next)).forEach(([provider, labels]) => {
    out[provider] = {
      ...(out[provider] || {}),
      ...labels
    };
  });
  return out;
}

function mergeAccountUpdatedAt(previous, refreshedAccountRefs, updatedAt) {
  const out = cloneAccountUpdatedAt(previous);
  refreshedAccountRefs.forEach((accountRef) => {
    out[accountRef] = updatedAt;
  });
  return out;
}

function mergeAccountSource(previous, next, refreshedAccountRefs) {
  const previousSource = previous || {};
  const nextSource = next || {};
  const out = {};
  const refs = new Set([
    ...Object.keys(previousSource),
    ...Object.keys(nextSource)
  ]);
  refreshedAccountRefs.forEach((accountRef) => refs.add(accountRef));
  refs.forEach((accountRef) => {
    if (Object.prototype.hasOwnProperty.call(nextSource, accountRef)) {
      const value = String(nextSource[accountRef] || '').trim();
      if (value) out[accountRef] = value;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(previousSource, accountRef)) {
      out[accountRef] = String(previousSource[accountRef] || '').trim();
    }
  });
  return out;
}

function mergeAccountScanned(previous, next, refreshedAccountRefs) {
  const previousSource = previous || {};
  const nextSource = next || {};
  const out = {};
  const refs = new Set([
    ...Object.keys(previousSource),
    ...Object.keys(nextSource)
  ]);
  refreshedAccountRefs.forEach((accountRef) => refs.add(accountRef));
  refs.forEach((accountRef) => {
    if (Object.prototype.hasOwnProperty.call(nextSource, accountRef)) {
      const value = Number(nextSource[accountRef] || 0);
      if (Number.isFinite(value) && value > 0) out[accountRef] = value;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(previousSource, accountRef)) {
      const value = Number(previousSource[accountRef] || 0);
      if (Number.isFinite(value) && value > 0) out[accountRef] = value;
    }
  });
  return out;
}

function buildAccountsSignature(state, accountLimit, accountScope = null) {
  // 探测账号数量会影响 byAccount 结果，必须进入缓存签名。
  return `${buildModelDiscoverySignature(state, {
    providerMode: 'auto',
    includeCodex: true,
    includeAccountModels: true,
    accountScope
  })}|limit=${accountLimit === 0 ? 'all' : accountLimit}`;
}

function resolveModelsProbeAccountLimit(options = {}, deps = {}) {
  const raw = deps.accountLimit !== undefined ? deps.accountLimit : options.modelsProbeAccounts;
  const value = Number(raw);
  if (Number.isFinite(value) && value <= 0) return 0;
  return Math.max(1, Math.min(128, value || 2));
}

async function refreshWebUiModelsCache(state, options, deps = {}) {
  const {
    fetchModelsForAccount
  } = deps;

  const accountLimit = resolveModelsProbeAccountLimit(options, deps);
  const accountScope = deps.accountScope || null;
  const probeCodex = deps.probeCodex === true;
  const signature = buildAccountsSignature(state, accountLimit, accountScope);
  const previousCache = ensureWebUiModelsCacheLoaded(state, deps);
  const discovery = await discoverProviderModels({
    state,
    options,
    fetchModelsForAccount,
    providerMode: 'auto',
    includeCodex: true,
    includeAccountModels: true,
    accountLimit,
    accountScope,
    probeCodex,
    // 后台刷新默认 2.5s；请求路径可通过 deps.timeoutMs 传更长超时
    // 避免冷启动时第三方端点响应慢导致别名候选验证失败 503
    timeoutMs: Math.max(1, Number(deps.timeoutMs) || 2500)
  });
  const accountRefs = listCurrentAccountCacheRefs(state, accountScope);
  const errorsByAccount = mergeErrorsByAccount(
    previousCache.errorsByAccount,
    discovery.errorsByAccount,
    discovery.byAccount,
    accountRefs
  );
  const byAccount = mergeByAccountCache(
    previousCache.byAccount,
    discovery.byAccount,
    errorsByAccount,
    accountRefs
  );
  const byProvider = mergeByProviderCache(previousCache.byProvider, discovery.byProvider, discovery.firstError, accountScope);
  const updatedAt = Date.now();

  state.webUiModelsCache = {
    updatedAt,
    byProvider,
    byAccount,
    errorsByAccount,
    accountUpdatedAt: mergeAccountUpdatedAt(previousCache.accountUpdatedAt, accountRefs, updatedAt),
    accountSource: mergeAccountSource(previousCache.accountSource, discovery.sourcesByAccount, accountRefs),
    accountScanned: mergeAccountScanned(previousCache.accountScanned, discovery.scannedByAccount, accountRefs),
    // 探测过程中 fetchModelsForAccount 已把 descriptors 写回账号,这里收集显示名。
    labels: mergeModelLabels(previousCache.labels, collectModelDisplayLabels(state)),
    signature,
    source: discovery.source,
    sourceCount: discovery.sourceCount,
    scannedAccounts: discovery.scannedAccounts,
    firstError: discovery.firstError
  };
  writePersistedWebUiModelsCache(deps, state.webUiModelsCache);
  // A successful credentialed probe proves the account's auth works now —
  // clear stale auth_invalid/cooldown circuits so the account (and its
  // models) become routable/selectable again without a manual admin clear.
  recoverProbedAccounts(state, discovery, {
    listAccountModelCacheRefs,
    accountStateService: deps.accountStateService
  });
  // 增量更新倒排索引（model→account / account→model），保持请求路径 O(1) 查询
  try {
    var _refreshIndex = require('./model-account-index');
    _refreshIndex.refreshOnCacheUpdate(state, options, discovery);
  } catch (_) { /* best-effort */ }
  return cloneByProvider(byProvider);
}

function selectScopedCacheSource(cache, accountRefs, hasModels, firstError) {
  const sources = accountRefs
    .map((accountRef) => String(cache.accountSource && cache.accountSource[accountRef] || '').trim())
    .filter(Boolean);
  if (sources.includes('remote')) return 'remote';
  if (sources.includes('local')) return 'local';
  if (sources.includes('error') || firstError) return hasModels ? 'local' : 'error';
  if (sources.includes('empty')) return hasModels ? 'local' : 'empty';
  if (hasModels) {
    const globalSource = String(cache.source || '').trim();
    return globalSource && globalSource !== 'empty' ? globalSource : 'local';
  }
  return 'empty';
}

function buildScopedCacheMeta(state, cache, accountScope) {
  if (!accountScope) {
    return {
      source: cache.source || 'empty',
      sourceCount: Number(cache.sourceCount || 0),
      scannedAccounts: Number(cache.scannedAccounts || 0),
      firstError: cache.firstError || ''
    };
  }

  const accountRefs = Array.from(listCurrentAccountCacheRefs(state, accountScope));
  let hasModels = false;
  let scannedAccounts = 0;
  let firstError = '';

  accountRefs.forEach((accountRef) => {
    const models = cache.byAccount && cache.byAccount[accountRef];
    if (Array.isArray(models) && models.length > 0) hasModels = true;
    const scanned = Number(cache.accountScanned && cache.accountScanned[accountRef] || 0);
    if (Number.isFinite(scanned)) scannedAccounts = Math.max(scannedAccounts, scanned);
    if (!firstError && cache.errorsByAccount && cache.errorsByAccount[accountRef]) {
      firstError = String(cache.errorsByAccount[accountRef] || '');
    }
  });

  return {
    source: selectScopedCacheSource(cache, accountRefs, hasModels, firstError),
    sourceCount: hasModels ? 1 : 0,
    scannedAccounts,
    firstError
  };
}

function buildWebUiModelsCacheResult(state, cache, cached, accountScope = null) {
  const meta = buildScopedCacheMeta(state, cache, accountScope);
  return {
    cached,
    updatedAt: cache.updatedAt,
    source: meta.source || (cached ? 'cache' : 'empty'),
    sourceCount: Number(meta.sourceCount || 0),
    scannedAccounts: Number(meta.scannedAccounts || 0),
    firstError: meta.firstError || '',
    models: cloneByProvider(cache.byProvider),
    byAccount: cloneByAccount(cache.byAccount),
    errorsByAccount: cloneErrorsByAccount(cache.errorsByAccount),
    labels: cloneModelLabels(cache.labels)
  };
}

async function getWebUiModelsCache(state, options, deps = {}) {
  const forceRefresh = Boolean(deps.forceRefresh);
  const cache = ensureWebUiModelsCacheLoaded(state, deps);
  const accountScope = deps.accountScope || null;

  if (!forceRefresh && cache && cache.updatedAt > 0) {
    return buildWebUiModelsCacheResult(state, cache, true, accountScope);
  }

  if (!forceRefresh) {
    return buildWebUiModelsCacheResult(state, cache || initWebUiModelsCache(), true, accountScope);
  }

  const models = await refreshWebUiModelsCache(state, options, deps);
  return {
    cached: false,
    updatedAt: state.webUiModelsCache.updatedAt,
    source: state.webUiModelsCache.source || 'refresh',
    sourceCount: Number(state.webUiModelsCache.sourceCount || 0),
    scannedAccounts: Number(state.webUiModelsCache.scannedAccounts || 0),
    firstError: state.webUiModelsCache.firstError || '',
    models,
    byAccount: cloneByAccount(state.webUiModelsCache.byAccount),
    errorsByAccount: cloneErrorsByAccount(state.webUiModelsCache.errorsByAccount),
    labels: cloneModelLabels(state.webUiModelsCache.labels)
  };
}

function invalidateWebUiModelsCache(state, deps = {}) {
  const nextCache = initWebUiModelsCache();
  state.webUiModelsCache = nextCache;
  writePersistedWebUiModelsCache(deps, nextCache);
  return nextCache;
}

function normalizeAccountRefs(accountRefs) {
  return Array.from(new Set((Array.isArray(accountRefs) ? accountRefs : [accountRefs])
    .map((accountRef) => String(accountRef || '').trim())
    .filter(Boolean)));
}

function deleteAccountRefsFromMap(target, accountRefs) {
  let changed = false;
  accountRefs.forEach((accountRef) => {
    if (!Object.prototype.hasOwnProperty.call(target, accountRef)) return;
    delete target[accountRef];
    changed = true;
  });
  return changed;
}

function invalidateWebUiModelsCacheAccountRefs(state, deps = {}, accountRefs = []) {
  const refs = normalizeAccountRefs(accountRefs);
  if (!state || refs.length < 1) return state && state.webUiModelsCache;

  const cache = normalizeWebUiModelsCache(ensureWebUiModelsCacheLoaded(state, deps));
  let changed = false;
  changed = deleteAccountRefsFromMap(cache.byAccount, refs) || changed;
  changed = deleteAccountRefsFromMap(cache.errorsByAccount, refs) || changed;
  changed = deleteAccountRefsFromMap(cache.accountUpdatedAt, refs) || changed;
  changed = deleteAccountRefsFromMap(cache.accountSource, refs) || changed;
  changed = deleteAccountRefsFromMap(cache.accountScanned, refs) || changed;

  if (!changed) {
    state.webUiModelsCache = cache;
    return cache;
  }

  cache.updatedAt = Date.now();
  cache.firstError = Object.values(cache.errorsByAccount).find((value) => String(value || '').trim()) || '';
  state.webUiModelsCache = cache;
  writePersistedWebUiModelsCache(deps, cache);
  return cache;
}

// 该 accountScope 下的账号缓存 ref 是否【从未被探测过】(无 accountUpdatedAt 时间戳)。
// 用于让 GET /models 对冷账号做一次首探（背景调度器默认每 45s-3min 才探 1 个冷账号、
// modelsProbeAccounts 默认 2 → 切到靠后的账号会长时间空 catalog）。只在"从未探测"时触发强制
// 刷新，探测过(哪怕结果为空/报错，accountUpdatedAt 已置)即交回背景调度器 backoff，避免每请求重探。
const SCOPED_EMPTY_REPROBE_MS = 60_000;

function accountScopeNeverProbed(state, deps, accountScope) {
  if (!accountScope) return false;
  try {
    const cache = ensureWebUiModelsCacheLoaded(state, deps);
    const refs = Array.from(listCurrentAccountCacheRefs(state, accountScope));
    if (refs.length === 0) return false;
    const hasModels = refs.some((ref) => Array.isArray(cache.byAccount && cache.byAccount[ref]) && cache.byAccount[ref].length > 0);
    if (hasModels) return false;
    const everProbed = refs.some((ref) => Number(cache.accountUpdatedAt && cache.accountUpdatedAt[ref]) > 0);
    if (!everProbed) return true;
    // 冷账号自愈:已探测过但缓存里仍无任何模型(多半是之前被 accountLimit 跳过、或旧代码/首次探测
    // 留下的空标记)。若距上次探测已超过阈值,再强制探一次,避免这类账号(尤其第三方 Anthropic
    // 协议代理)永久卡在会话「无可用模型」。一旦探到模型(或手动注册后)hasModels 为真即停止重探。
    const lastAt = Math.max(0, ...refs.map((ref) => Number(cache.accountUpdatedAt && cache.accountUpdatedAt[ref]) || 0));
    return (Date.now() - lastAt) > SCOPED_EMPTY_REPROBE_MS;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  WEBUI_MODELS_CACHE_TTL_MS,
  WEBUI_MODELS_CACHE_FILE,
  accountScopeNeverProbed,
  ensureWebUiModelsCacheLoaded,
  initWebUiModelsCache,
  readPersistedWebUiModelsCache,
  refreshWebUiModelsCache,
  getWebUiModelsCache,
  invalidateWebUiModelsCache,
  invalidateWebUiModelsCacheAccountRefs,
  buildAccountsSignature,
  writePersistedWebUiModelsCache,
  resolveModelsProbeAccountLimit
};
