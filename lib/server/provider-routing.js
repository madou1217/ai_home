'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  inferProviderFromModel,
  listEnabledProviders,
  normalizeModelId
} = require('./providers');
const { listModelIdLookupKeys } = require('./model-id');
const {
  findAccountsForModel,
  findRoutableAccountsForModel
} = require('./model-account-index');

function normalizeExplicitProvider(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider) ? provider : '';
}

function getRequestedModel(requestJson) {
  return String(requestJson && requestJson.model || '').trim();
}

function hasModel(models, requestedModel) {
  const wanted = listModelIdLookupKeys(requestedModel);
  if (wanted.length < 1 || !Array.isArray(models)) return false;
  const available = new Set();
  models.forEach((item) => {
    listModelIdLookupKeys(item).forEach((key) => available.add(key));
  });
  return wanted.some((key) => available.has(key));
}

function registryHasModel(state, provider, requestedModel) {
  const providerModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  if (!(providerModels instanceof Set)) return false;
  return listModelIdLookupKeys(requestedModel).some((key) => providerModels.has(key));
}

function cacheHasModel(state, provider, requestedModel) {
  const models = state
    && state.webUiModelsCache
    && state.webUiModelsCache.byProvider
    && state.webUiModelsCache.byProvider[provider];
  return hasModel(models, requestedModel);
}

function accountsHaveModel(state, provider, requestedModel) {
  return false;
}

function getModelAvailabilityScore(state, provider, requestedModel) {
  let score = 0;
  if (cacheHasModel(state, provider, requestedModel)) score += 80;
  if (registryHasModel(state, provider, requestedModel)) score += 70;
  return score;
}

/**
 * 倒排索引里「这个 provider 有**活账号**绑定了该模型」是逐账号探测出来的事实，
 * 比 provider 级缓存(byProvider)硬得多：后者是一次探测的并集，账号被删掉之后，
 * 它的模型还会继续挂在 provider 名下，直到下一次完整探测才消失。
 *
 * 实际踩到的坑：一个已删除账号把 `claude-opus-4-6-thinking` 留在了
 * byProvider.claude 里，于是「缓存 80 + 同族 5」让 claude 压过真正提供该模型的
 * agy（80），请求被送到官方 Anthropic —— 那边根本没有这个模型 id，回 404
 * not_found_error，CLI 显示成「模型不存在或无权限」，把配额问题伪装成模型问题。
 *
 * @returns {number} 2=有可调度的绑定账号；1=有绑定账号但当前被熔断/不可调度；0=没有绑定
 */
function getModelBindingScore(state, provider, requestedModel) {
  const index = state && state.modelAccountIndex;
  if (!index || !(index.builtAt > 0)) return 0;
  if (findRoutableAccountsForModel(index, requestedModel, provider).length > 0) return 2;
  const accountByRef = index.accountByRef instanceof Map ? index.accountByRef : null;
  if (!accountByRef) return 0;
  // 绑定账号全被熔断时仍然算数：让请求停在「真的有这个模型」的 provider 上拿到
  // 诚实的 429/retry-after，好过甩到一个必定 404 的 provider。
  const bound = findAccountsForModel(index, requestedModel).some((accountRef) => {
    const account = accountByRef.get(accountRef);
    return Boolean(account) && String(account.provider || '').trim().toLowerCase() === provider;
  });
  return bound ? 1 : 0;
}

function inferKnownProviderFamily(modelRaw) {
  const model = normalizeModelId(modelRaw);
  if (!model) return '';
  if (model.startsWith('agy') || model.startsWith('antigravity')) {
    return 'agy';
  }
  if (model.startsWith('opencode-go/') || model.startsWith('opencode/')) return 'opencode';
  // Grok 模型属于 Grok provider，不能因缺少显式请求头而落到 Claude。
  if (model.startsWith('grok')) return 'grok';
  if (
    model === 'k3'
    || model.startsWith('k3-')
    || model.startsWith('kimi')
    || model.startsWith('moonshot')
  ) return 'kimi';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('glm') || model.startsWith('zcode')) return 'zcode';
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'claude';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex';
  return '';
}

function resolveByModelAvailability(options, requestJson, state) {
  const requestedModel = getRequestedModel(requestJson);
  if (!requestedModel) return '';

  const providers = listEnabledProviders(options && options.provider);
  const familyProvider = inferKnownProviderFamily(requestedModel);

  // 有逐账号事实时先用它定盘：只在绑定强度最高的那批 provider 里挑，
  // 同族加成退化成同分裁决，不再能把请求从「真有这个模型的 provider」拽走。
  const bindingByProvider = new Map(
    providers.map((provider) => [provider, getModelBindingScore(state, provider, requestedModel)])
  );
  const bestBinding = Math.max(0, ...bindingByProvider.values());
  if (bestBinding > 0) {
    const bound = providers
      .filter((provider) => bindingByProvider.get(provider) === bestBinding)
      .sort((left, right) => {
        if (familyProvider === left && familyProvider !== right) return -1;
        if (familyProvider === right && familyProvider !== left) return 1;
        return SUPPORTED_SERVER_PROVIDERS.indexOf(left) - SUPPORTED_SERVER_PROVIDERS.indexOf(right);
      });
    if (bound.length > 0) return bound[0];
  }

  // 索引还没热/该模型没有任何账号绑定 —— 没有事实可用，维持原来的缓存+注册表打分。
  const ranked = providers
    .map((provider) => {
      const availabilityScore = getModelAvailabilityScore(state, provider, requestedModel);
      const familyScore = familyProvider === provider ? 5 : 0;
      return {
        provider,
        score: availabilityScore + familyScore,
        availabilityScore,
        familyScore,
        index: SUPPORTED_SERVER_PROVIDERS.indexOf(provider)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.availabilityScore !== a.availabilityScore) return b.availabilityScore - a.availabilityScore;
      return a.index - b.index;
    });

  return ranked.length > 0 ? ranked[0].provider : '';
}

function resolveRequestProvider(options = {}, requestJson = {}, reqHeaders = {}, state = null) {
  const explicitHeaderProvider = normalizeExplicitProvider(
    reqHeaders && (reqHeaders['x-provider'] || reqHeaders['X-Provider'])
  );
  if (explicitHeaderProvider) return explicitHeaderProvider;

  const explicitRequestProvider = normalizeExplicitProvider(requestJson && requestJson.provider);
  if (explicitRequestProvider) return explicitRequestProvider;

  const configuredProvider = normalizeExplicitProvider(options && options.provider);
  if (configuredProvider) return configuredProvider;

  const availabilityProvider = resolveByModelAvailability(options, requestJson, state);
  if (availabilityProvider) return availabilityProvider;

  return inferProviderFromModel(getRequestedModel(requestJson));
}

module.exports = {
  resolveRequestProvider,
  normalizeExplicitProvider,
  __private: {
    getRequestedModel,
    hasModel,
    accountsHaveModel,
    cacheHasModel,
    registryHasModel,
    resolveByModelAvailability,
    getModelBindingScore,
    inferKnownProviderFamily
  }
};
