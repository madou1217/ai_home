'use strict';

const { listEnabledProviders } = require('./providers');
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

function getProviderAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
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
  addModels(models, account && account.availableModels);
  addModels(models, collectDescriptorModels(account));
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
  const providers = normalizeProviderList(providerMode, includeCodex);

  return providers.map((provider) => {
    const registry = includeRegistry && !accountScope ? sortModels(getRegistryModels(state, provider)).join(',') : '';
    const accounts = getProviderAccounts(state, provider)
      .filter((account) => accountMatchesScope(provider, account, accountScope))
      .map((account) => {
        const authType = getAccountAuthKind(provider, account);
        const tokenState = String(account && account.accessToken || '').trim() ? 'token' : 'no-token';
        return `${getAccountRef(account) || 'missing-account-ref'}[${authType}:${tokenState}]`;
      })
      .sort()
      .join(';');
    return `${provider}:r=${registry}:a=${accounts}`;
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
  const accountLimitInput = Number(params.accountLimit);
  const accountLimit = Number.isFinite(accountLimitInput) && accountLimitInput <= 0
    ? Number.POSITIVE_INFINITY
    : Math.max(1, accountLimitInput || 1);
  const timeoutMs = Math.max(1, Number(params.timeoutMs) || 8000);
  const ignoreAvailableModelsSnapshot = params.ignoreAvailableModelsSnapshot !== false;
  const providers = normalizeProviderList(providerMode, includeCodex);
  const localByProvider = {};
  const remoteByProvider = {};
  const byProvider = {};
  const byAccount = {};
  const errorsByAccount = {};
  const sourcesByAccount = {};
  const scannedByAccount = {};
  const probeItems = [];
  const probeCounts = new Map();

  providers.forEach((provider) => {
    const localModels = new Set();
    const remoteModels = new Set();
    if (includeRegistry && !accountScope) addModels(localModels, getRegistryModels(state, provider));

    const accounts = getProviderAccounts(state, provider);
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
        }
      }
      if (!shouldProbeAccountModels(provider, account)) return;
      const count = probeCounts.get(provider) || 0;
      if (Number.isFinite(accountLimit) && count >= accountLimit) return;
      probeItems.push({ provider, account });
      probeCounts.set(provider, count + 1);
    });

    localByProvider[provider] = localModels;
    remoteByProvider[provider] = remoteModels;
  });

  let firstError = '';
  let sourceCount = 0;
  const remoteOptions = ignoreAvailableModelsSnapshot
    ? { ...options, ignoreAvailableModelsSnapshot: true }
    : options;

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
        });
        setAccountMetadata(sourcesByAccount, item.provider, item.account, 'error');
        setAccountMetadata(scannedByAccount, item.provider, item.account, 1);
        if (!firstError) firstError = errorMessage;
        return;
      }
      accountRefs.forEach((accountRef) => {
        byAccount[accountRef] = models;
      });
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
    sourcesByAccount,
    scannedByAccount,
    scannedAccounts: probeItems.length,
    sourceCount,
    firstError,
    source: remoteModelCount > 0 ? 'remote' : (firstError ? 'error' : (localModelCount > 0 ? 'local' : 'empty')),
    signature: buildModelDiscoverySignature(state, {
      providerMode,
      includeCodex,
      includeRegistry,
      includeAccountModels,
      accountScope
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
  shouldProbeAccountModels,
  __private: {
    accountMatchesScope,
    getAccountRef,
    isApiKeyAccount,
    isCodexOauthAccount,
    listAccountModelCacheRefs,
    normalizeAccountScope,
    resolveAccountProbeTimeoutMs,
    shouldRejectEmptyRemoteModels,
    shouldReportLocalOnlyAccountModels,
    shouldProbeAccountModels
  }
};
