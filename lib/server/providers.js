'use strict';

const { normalizeModelId } = require('./model-id');
const {
  DEPRECATED_GATEWAY_PROVIDERS,
  PROVIDER_IDS,
  isKnownProvider,
  normalizeProviderId
} = require('../provider-catalog');

const SUPPORTED_SERVER_PROVIDERS = PROVIDER_IDS;

// gemini(非 agy）CLI / code-assist 已废弃：agy(antigravity）才是 gemini-* 模型的实际服务方。
// 把 gemini 从【网关 auto 路由可选 provider】里剔除，gemini-* 模型只路由到 agy，不再误落到已死的
// gemini provider。仅影响 auto 路由集合；显式 provider=gemini（账号管理/手动指定）仍照常可用。
function listGatewayRoutableProviders() {
  return SUPPORTED_SERVER_PROVIDERS.filter((provider) => !DEPRECATED_GATEWAY_PROVIDERS.includes(provider));
}

function inferProviderFromModel(modelRaw) {
  const model = normalizeModelId(modelRaw);
  if (!model) return 'codex';
  if (model.startsWith('agy') || model.startsWith('antigravity')) {
    return 'agy';
  }
  if (model.startsWith('opencode-go/') || model.startsWith('opencode/') || model.startsWith('opencode-')) return 'opencode';
  
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'claude';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex';
  return 'codex';
}

function isSupportedProvider(providerRaw) {
  return isKnownProvider(providerRaw);
}

function listEnabledProviders(providerMode) {
  const mode = normalizeProviderId(providerMode);
  if (mode === 'auto') return SUPPORTED_SERVER_PROVIDERS.slice();
  if (isSupportedProvider(mode)) return [mode];
  return SUPPORTED_SERVER_PROVIDERS.slice();
}

// 已废弃 provider 在 auto 路由里应排在最后（最低优先级）：保留它能被【显式指定】和【最后兜底】，
// 但同名模型有非废弃 provider 可选时，绝不优先选废弃的。gemini-* 因此优先走 agy 而非死的 gemini。
function isDeprecatedGatewayProvider(providerRaw) {
  const provider = normalizeProviderId(providerRaw);
  return DEPRECATED_GATEWAY_PROVIDERS.includes(provider);
}

module.exports = {
  SUPPORTED_SERVER_PROVIDERS,
  DEPRECATED_GATEWAY_PROVIDERS,
  normalizeModelId,
  inferProviderFromModel,
  isSupportedProvider,
  isDeprecatedGatewayProvider,
  listEnabledProviders,
  listGatewayRoutableProviders
};
