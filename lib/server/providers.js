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
  if (model.startsWith('grok')) return 'grok';
  if (
    model === 'k3'
    || model.startsWith('k3-')
    || model.startsWith('kimi')
    || model.startsWith('moonshot')
  ) return 'kimi';
  if (model.startsWith('kiro') || model.startsWith('kr/')) return 'kiro';
  // Cline Pass 的模型 ID 自带 `cline-pass/` 命名空间；裸模型名（`glm-5.3`）不认，
  // 否则会与 zcode 的 glm-* 抢路由（见 cline-models.js）。
  if (model.startsWith('cline-pass/')) return 'cline';
  if (model.startsWith('glm') || model.startsWith('zcode')) return 'zcode';
  
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'claude';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex';
  return 'codex';
}

// 严格版归属推断：只认「provider 专属命名空间」的模型 ID，认不出时返回 ''（绝不兜底 codex）。
// 与 inferProviderFromModel 的差别是「不知道就说不知道」：别名（target_provider=auto）在模型目录
// 无法裁决 provider 时用它做兜底归属。claude-*/gpt-*/gemini-*/glm-*/kimi-*/grok-* 这类家族名或
// 多 provider 可服务的裸模型名绝不算专属命名空间（agy 服务 claude-*、中转账号普遍收编别家裸模型名），
// 钉错 provider 会把别名目标模型发给不认识它的上游并产出误导性 503。
function inferProviderFromScopedModelId(modelRaw) {
  const model = normalizeModelId(modelRaw);
  if (!model) return '';
  if (model.startsWith('cline-pass/')) return 'cline';
  if (model.startsWith('opencode-go/') || model.startsWith('opencode/') || model.startsWith('opencode-')) return 'opencode';
  if (model.startsWith('agy') || model.startsWith('antigravity')) return 'agy';
  if (model.startsWith('kiro') || model.startsWith('kr/')) return 'kiro';
  return '';
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
  inferProviderFromScopedModelId,
  isSupportedProvider,
  isDeprecatedGatewayProvider,
  listEnabledProviders,
  listGatewayRoutableProviders
};
