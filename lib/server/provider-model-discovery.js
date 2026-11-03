'use strict';

const { listEnabledProviders } = require('./providers');
const { listModelDiscoveryAccounts } = require('./model-discovery-accounts');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { isPublicCatalogModelId } = require('./model-id');
const { isAccountRef } = require('./account-ref-store');
const { isClaudeAuthTokenAccount } = require('../account/claude-credential');
const { supportsNativeCliModelDiscovery } = require('./native-cli-model-discovery');

function normalizeModelId(modelRaw) {
  return String(modelRaw || '').trim();
}

function addModels(target, models) {
  if (!(target instanceof Set)) return;
  (Array.isArray(models) ? models : []).forEach((model) => {
    const id = normalizeModelId(model);
    if (isPublicCatalogModelId(id)) target.add(id);
  });
}

function sortModels(models) {
  return Array.from(models instanceof Set ? models : new Set(models || []))
    .map((model) => normalizeModelId(model))
    .filter(isPublicCatalogModelId)
    .sort();
}

function parseCsvModels(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalizeModelId(item))
    .filter(Boolean);
}

// 运行时账号池 + 只参与模型发现的账号（CodeBuddy / WorkBuddy 家族），见 model-discovery-accounts.js。
function getProviderAccounts(state, provider, deps) {
  return listModelDiscoveryAccounts(state, provider, deps);
}

function getRegistryModels(state, provider) {
  const providerModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  return providerModels instanceof Set ? Array.from(providerModels) : [];
}

function getAccountRef(account) {
  const accountRef = String(account && account.accountRef || '').trim();
  return isAccountRef(accountRef) ? accountRef : '';
}

function listAccountModelCacheRefs(provider, account) {
  const accountRef = getAccountRef(account);
  return accountRef ? [accountRef] : [];
}

function setAccountMetadata(target, provider, account, value) {
  listAccountModelCacheRefs(provider, account).forEach((accountRef) => {
    target[accountRef] = value;
  });
}

function getCachedAccountModels(state, provider, account) {
  const models = new Set();
  const accountRefs = listAccountModelCacheRefs(provider, account);
  [
    state && state.webUiModelsCache && state.webUiModelsCache.byAccount,
    state && state.modelsCache && state.modelsCache.byAccount
  ].forEach((source) => {
    if (!source || typeof source !== 'object') return;
    accountRefs.forEach((accountRef) => addModels(models, source[accountRef]));
  });
  return sortModels(models);
}

function normalizeAccountScope(value) {
  const accountRef = String(value && value.accountRef || '').trim();
  if (!isAccountRef(accountRef)) return null;
  return { accountRef };
}

/**
 * 单账号探测的快速通道：调用方（后台调度器）手上已经有 provider + 账号对象，
 * 不必为了探一个账号把全池 10k 个账号枚举一遍。
 * 与 accountScope 同时给出时必须指向同一个 ref，避免探错账号。
 */
function normalizeScopedAccount(value, accountScope = null) {
  if (!value || typeof value !== 'object' || !value.account) return null;
  const provider = String(value.provider || '').trim().toLowerCase();
  if (!provider) return null;
  const accountRef = getAccountRef(value.account);
  if (!accountRef) return null;
  const scope = normalizeAccountScope(accountScope);
  if (scope && scope.accountRef !== accountRef) return null;
  return { provider, account: value.account };
}

function accountMatchesScope(provider, account, scope) {
  const target = normalizeAccountScope(scope);
  if (!target) return true;
  return getAccountRef(account) === target.accountRef;
}

function isApiKeyAccount(account) {
  return Boolean(account && (account.apiKeyMode || String(account.authType || '').trim().toLowerCase() === 'api-key'));
}

function isCodexOauthAccount(provider, account) {
  return String(provider || '').trim().toLowerCase() === 'codex' && !isApiKeyAccount(account);
}

function getAccountAuthKind(provider, account) {
  if (String(provider || '').trim().toLowerCase() === 'claude' && isClaudeAuthTokenAccount(account)) {
    return 'auth-token';
  }
  return isApiKeyAccount(account) ? 'api-key' : 'oauth';
}

function collectDescriptorModels(account) {
  return []
    .concat(Array.isArray(account && account.codeAssistModelDescriptors) ? account.codeAssistModelDescriptors : [])
    .concat(Array.isArray(account && account.availableModelDescriptors) ? account.availableModelDescriptors : [])
    .concat(Array.isArray(account && account.modelDescriptors) ? account.modelDescriptors : [])
    .map((descriptor) => String(descriptor && (descriptor.id || descriptor.modelId) || '').trim())
    .filter(Boolean);
}

function collectAccountLocalModels(state, options, provider, account) {
  const models = new Set();
  const codexOauth = isCodexOauthAccount(provider, account);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  addModels(models, account && account.availableModels);
  addModels(models, collectDescriptorModels(account));
  // 对于 zcode OAuth 账号，配额快照里的 entries 就是权威的模型清单（如 glm-5.3）
  if (normalizedProvider === 'zcode' && account && account.usageSnapshot && Array.isArray(account.usageSnapshot.entries)) {
    account.usageSnapshot.entries.forEach((e) => {
      if (e && e.bucket) addModels(models, [e.bucket]);
    });
  }
  if (!codexOauth) addModels(models, getCachedAccountModels(state, provider, account));
  if (codexOauth) {
    addModels(models, getRegistryModels(state, 'codex'));
    addModels(models, parseCsvModels(options && options.codexModels));
  }
  return sortModels(models);
}

function shouldReportLocalOnlyAccountModels(provider, account) {
  return Boolean(account && account.accessToken && isCodexOauthAccount(provider, account));
}

function shouldRejectEmptyRemoteModels(provider, account) {
  // codex(含 api-key 转售端点如 yesboss)返回空 /models 几乎总是探测瞬时失败/被限流,
  // 不是"该账号服务 0 个模型"。一律按【探测失败】处理 → mergeByAccountCache 保留上次已知
  // 绑定,避免把 gpt-5.5→codex 的路由资格抹成 [] → countAvailableAccountsForModel=0 → 503。
  // 此前仅 OAuth codex 走本路径、api-key codex 却"信任空结果"——两者不对称正是 codex-1
  // "探测后掉出路由"的根因。现统一:api-key codex 无本地兜底绑定,更不能信任空探测。
  return String(provider || '').trim().toLowerCase() === 'codex';
}

function buildEmptyRemoteModelsError(provider, account) {
  if (String(provider || '').trim().toLowerCase() === 'codex') return 'empty_codex_models_catalog';
  return 'empty_models_catalog';
}

function shouldProbeAccountModels(provider, account) {
  if (!account) return false;
  if (!getAccountRef(account)) return false;
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const runtime = deriveAccountRuntimeStatus(account);
  if (runtime && runtime.status === 'auth_invalid') return false;
  if (supportsNativeCliModelDiscovery(normalizedProvider)) return true;
  // zcode OAuth 账号使用 zcodeJwtToken 探测，不依赖 accessToken
  if (normalizedProvider === 'zcode' && !isApiKeyAccount(account)) {
    return Boolean(account.zcodeJwtToken || account.accessToken);
  }
  if (!account.accessToken) return false;
  // claude auth-token(第三方 Anthropic 协议代理:GLM/DeepSeek/JD…)也参与探测:支持 /v1/models 的
  // 代理能拿真实模型;不支持的抛错被上层捕获、退回手动注册。此前一律排除→会话「无可用模型」。
  // fetchModelsForAccount 已相应放开(Bearer、/v1/models、不发 oauth-beta)。
  // Codex OAuth uses the Codex native /models endpoint, not OpenAI-compatible /v1/models.
  if (normalizedProvider === 'codex' && isCodexOauthAccount(provider, account)) return true;
  return true;
}

function resolveAccountProbeTimeoutMs(provider, timeoutMs) {
  return Math.max(1, Number(timeoutMs) || 8000);
}

function normalizeProviderList(providerMode, includeCodex) {
  return listEnabledProviders(providerMode)
    .filter((provider) => includeCodex || provider !== 'codex');
}

function buildModelDiscoverySignature(state, params = {}) {
  const providerMode = params.providerMode || 'auto';
  const includeCodex = params.includeCodex === true;
  const includeRegistry = params.includeRegistry !== false;
  const accountScope = normalizeAccountScope(params.accountScope);
  const scopedAccount = normalizeScopedAccount(params.scopedAccount, accountScope);
  const providers = normalizeProviderList(providerMode, includeCodex)
    .filter((provider) => !scopedAccount || provider === scopedAccount.provider);

  // 单账号刷新：签名只看这一个账号（O(1)），不再枚举全池账号拼字符串。
  if (scopedAccount) {
    const account = scopedAccount.account;
    const authType = getAccountAuthKind(scopedAccount.provider, account);
    const tokenState = String(account && account.accessToken || '').trim() ? 'token' : 'no-token';
    const codexVersion = scopedAccount.provider === 'codex'
      ? String(params.codexClientVersion || '').trim()
      : '';
    return `${scopedAccount.provider}:r=:a=${getAccountRef(account) || 'missing-account-ref'}[${authType}:${tokenState}]${codexVersion ? `:v=${codexVersion}` : ''}`;
  }

  return providers.map((provider) => {
    const registry = includeRegistry && !accountScope ? sortModels(getRegistryModels(state, provider)).join(',') : '';
    const accounts = getProviderAccounts(state, provider, params)
      .filter((account) => accountMatchesScope(provider, account, accountScope))
      .map((account) => {
        const authType = getAccountAuthKind(provider, account);
        const tokenState = String(account && account.accessToken || '').trim() ? 'token' : 'no-token';
        return `${getAccountRef(account) || 'missing-account-ref'}[${authType}:${tokenState}]`;
      })
      .sort()
      .join(';');
    const codexVersion = provider === 'codex'
      ? String(params.codexClientVersion || '').trim()
      : '';
    return `${provider}:r=${registry}:a=${accounts}${codexVersion ? `:v=${codexVersion}` : ''}`;
  }).join('|');
}

async function discoverProviderModels(params = {}) {
  const {
    state,
    fetchModelsForAccount
  } = params;
  const options = params.options || {};
  const providerMode = params.providerMode || options.provider || 'auto';
  const includeCodex = params.includeCodex === true;
  const includeRegistry = params.includeRegistry !== false;
  const includeAccountModels = params.includeAccountModels === true;
  const accountScope = normalizeAccountScope(params.accountScope);
  const scopedAccount = normalizeScopedAccount(params.scopedAccount, accountScope);
  const accountLimitInput = Number(params.accountLimit);
  const accountLimit = Number.isFinite(accountLimitInput) && accountLimitInput <= 0
    ? Number.POSITIVE_INFINITY
    : Math.max(1, accountLimitInput || 1);
  const timeoutMs = Math.max(1, Number(params.timeoutMs) || 8000);
  const ignoreAvailableModelsSnapshot = params.ignoreAvailableModelsSnapshot !== false;
  const providers = normalizeProviderList(providerMode, includeCodex)
    .filter((provider) => !scopedAccount || provider === scopedAccount.provider);
  const localByProvider = {};
  const remoteByProvider = {};
  const byProvider = {};
  const byAccount = {};
  const errorsByAccount = {};
  // 目录残缺的账号（探测只拿到部分上游腿）：这份列表**不是**完整目录，
  // 不能用来否定该账号能服务缺失的模型（见 model-pool-narrowing 的强证据排除）。
  const incompleteByAccount = {};
  // 结构化探测失败：统一门禁（account-runtime-gate）需要原始状态码/正文才能按与推理
  // 请求完全相同的规则分类。errorsByAccount 只保留人类可读文案（兼容既有消费方）。
  const failuresByAccount = {};
  const sourcesByAccount = {};
  const scannedByAccount = {};
  const probeItems = [];
  const probeCounts = new Map();
  // 本次探测真正写到 metadata 的账号（本地声明上报 + 真正发起探测）。
  // 下游（account-probe-recovery 的门禁观察）只需要这些账号；10k 账号时让它扫全池是
  // O(n) 白工——没被探测的账号在两个判定里都是 no-op。按对象去重，避免同一账号在
  // 「上报本地模型」和「发起探测」两处各记一次。
  const touchedAccounts = [];
  const touchedSeen = new Set();
  function markTouched(provider, account) {
    const key = account && typeof account === 'object' ? account : null;
    if (key && touchedSeen.has(key)) return;
    if (key) touchedSeen.add(key);
    touchedAccounts.push({ provider, account });
  }

  providers.forEach((provider) => {
    const localModels = new Set();
    const remoteModels = new Set();
    if (includeRegistry && !accountScope) addModels(localModels, getRegistryModels(state, provider));

    const accounts = scopedAccount && provider === scopedAccount.provider
      ? [scopedAccount.account]
      : getProviderAccounts(state, provider, params);
    accounts.filter((account) => accountMatchesScope(provider, account, accountScope)).forEach((account) => {
      const accountLocalModels = includeAccountModels
        ? collectAccountLocalModels(state, options, provider, account)
        : [];
      if (includeAccountModels) {
        addModels(localModels, accountLocalModels);
        if (accountLocalModels.length > 0 || shouldReportLocalOnlyAccountModels(provider, account)) {
          listAccountModelCacheRefs(provider, account).forEach((accountRef) => {
            byAccount[accountRef] = accountLocalModels.slice();
          });
          setAccountMetadata(sourcesByAccount, provider, account, accountLocalModels.length > 0 ? 'local' : 'empty');
          setAccountMetadata(scannedByAccount, provider, account, 0);
          markTouched(provider, account);
        }
      }
      if (!shouldProbeAccountModels(provider, account)) return;
      const count = probeCounts.get(provider) || 0;
      if (Number.isFinite(accountLimit) && count >= accountLimit) return;
      probeItems.push({ provider, account });
      markTouched(provider, account);
      probeCounts.set(provider, count + 1);
    });

    localByProvider[provider] = localModels;
    remoteByProvider[provider] = remoteModels;
  });

  let firstError = '';
  let sourceCount = 0;
  // 模型探测需要账号级运行时元数据（ZCode 的 Device Mid 与宿主 app 版本）。
  // 将这些只读依赖沿探测链传递，不改变现有 provider 的请求选项。
  const remoteOptions = {
    ...options,
    ...(params.fs ? { fs: params.fs } : {}),
    ...(params.aiHomeDir ? { aiHomeDir: params.aiHomeDir } : {}),
    ...(params.processObj ? { processObj: params.processObj } : {}),
    ...(params.hostHomeDir ? { hostHomeDir: params.hostHomeDir } : {}),
    ...(ignoreAvailableModelsSnapshot ? { ignoreAvailableModelsSnapshot: true } : {})
  };

  if (typeof fetchModelsForAccount === 'function' && probeItems.length > 0) {
    const settled = await Promise.allSettled(
      probeItems.map((item) => fetchModelsForAccount(
        remoteOptions,
        item.account,
        resolveAccountProbeTimeoutMs(item.provider, timeoutMs)
      ))
    );
    settled.forEach((result, index) => {
      const item = probeItems[index];
      const accountRefs = listAccountModelCacheRefs(item.provider, item.account);
      if (result.status !== 'fulfilled') {
        // 保留账号级探测错误，前端可区分“已配置”和“模型接口已探测”。
        const errorMessage = String((result.reason && result.reason.message) || result.reason || '');
        accountRefs.forEach((accountRef) => {
          byAccount[accountRef] = Array.isArray(byAccount[accountRef]) ? byAccount[accountRef].slice() : [];
          errorsByAccount[accountRef] = errorMessage;
          failuresByAccount[accountRef] = {
            reason: 'request_failed',
            statusCode: Number(result.reason && result.reason.status) || 0,
            detail: errorMessage,
            error: result.reason
          };
        });
        setAccountMetadata(sourcesByAccount, item.provider, item.account, 'error');
        setAccountMetadata(scannedByAccount, item.provider, item.account, 1);
        if (!firstError) firstError = errorMessage;
        return;
      }

      const models = sortModels(result.value);
      if (models.length < 1 && shouldRejectEmptyRemoteModels(item.provider, item.account)) {
        const errorMessage = buildEmptyRemoteModelsError(item.provider, item.account);
        accountRefs.forEach((accountRef) => {
          byAccount[accountRef] = Array.isArray(byAccount[accountRef]) ? byAccount[accountRef].slice() : [];
          errorsByAccount[accountRef] = errorMessage;
          // 空目录不是上游错误（端点可达、凭据通过），因此不参与异常记账。
          failuresByAccount[accountRef] = { reason: 'empty_catalog', statusCode: 0, detail: errorMessage };
        });
        setAccountMetadata(sourcesByAccount, item.provider, item.account, 'error');
        setAccountMetadata(scannedByAccount, item.provider, item.account, 1);
        if (!firstError) firstError = errorMessage;
        return;
      }
      accountRefs.forEach((accountRef) => {
        byAccount[accountRef] = models;
      });
      // 目录残缺（例如 opencode 的 Go/Zen 只回来一条腿）：记下这个事实，下游不能用
      // 这份列表反证「账号不支持缺失的模型」。见 model-pool-narrowing 的强证据排除。
      if (result.value && result.value.catalogIncomplete === true) {
        const reason = String(result.value.catalogIncompleteReason || 'partial_catalog');
        accountRefs.forEach((accountRef) => {
          incompleteByAccount[accountRef] = reason;
        });
        if (!firstError) firstError = reason;
      }
      setAccountMetadata(sourcesByAccount, item.provider, item.account, models.length > 0 ? 'remote' : 'empty');
      setAccountMetadata(scannedByAccount, item.provider, item.account, 1);
      if (models.length > 0) sourceCount += 1;
      addModels(remoteByProvider[item.provider], models);
    });
  }

  let remoteModelCount = 0;
  let localModelCount = 0;
  providers.forEach((provider) => {
    const remoteModels = remoteByProvider[provider] || new Set();
    const localModels = localByProvider[provider] || new Set();
    remoteModelCount += remoteModels.size;
    localModelCount += localModels.size;
    byProvider[provider] = sortModels(remoteModels.size > 0 ? remoteModels : localModels);
  });

  const allModels = new Set();
  Object.values(byProvider).forEach((models) => addModels(allModels, models));

  return {
    byProvider,
    ids: sortModels(allModels),
    byAccount,
    errorsByAccount,
    incompleteByAccount,
    failuresByAccount,
    sourcesByAccount,
    scannedByAccount,
    touchedAccounts,
    scannedAccounts: probeItems.length,
    sourceCount,
    firstError,
    source: remoteModelCount > 0 ? 'remote' : (firstError ? 'error' : (localModelCount > 0 ? 'local' : 'empty')),
    signature: buildModelDiscoverySignature(state, {
      providerMode,
      includeCodex,
      includeRegistry,
      includeAccountModels,
      accountScope,
      scopedAccount,
      fs: params.fs,
      aiHomeDir: params.aiHomeDir
    })
  };
}

module.exports = {
  discoverProviderModels,
  accountMatchesScope,
  buildModelDiscoverySignature,
  getAccountRef,
  listAccountModelCacheRefs,
  normalizeAccountScope,
  normalizeScopedAccount,
  shouldProbeAccountModels,
  __private: {
    accountMatchesScope,
    getAccountRef,
    isApiKeyAccount,
    isCodexOauthAccount,
    listAccountModelCacheRefs,
    normalizeAccountScope,
    normalizeScopedAccount,
    resolveAccountProbeTimeoutMs,
    shouldRejectEmptyRemoteModels,
    shouldReportLocalOnlyAccountModels,
    shouldProbeAccountModels
  }
};
