'use strict';

const { SUPPORTED_SERVER_PROVIDERS, listEnabledProviders } = require('./providers');
const { getModelModalities } = require('./model-modality-index');
const { resolveModelEfforts } = require('./model-effort-index');

const FALLBACK_MODELS = [];

function normalizeModelId(modelRaw) {
  return String(modelRaw || '').trim().toLowerCase();
}

function initModelRegistry() {
  const providers = {};
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    providers[provider] = new Set();
  });
  return {
    updatedAt: Date.now(),
    providers
  };
}

function addModelToRegistry(registry, provider, model) {
  if (!registry || !registry.providers) return;
  if (!provider || !registry.providers[provider]) return;
  const m = normalizeModelId(model);
  if (!m) return;
  registry.providers[provider].add(m);
  registry.updatedAt = Date.now();
}

function getRegistryModelList(registry, providerMode = 'auto') {
  if (!registry || !registry.providers) return FALLBACK_MODELS.slice();
  const out = new Set();
  const providers = listEnabledProviders(providerMode);
  providers.forEach((provider) => {
    const providerModels = registry.providers && registry.providers[provider];
    if (!(providerModels instanceof Set)) return;
    providerModels.forEach((m) => out.add(m));
  });
  if (out.size === 0) return FALLBACK_MODELS.slice();
  return Array.from(out).sort();
}

function inferModelOwnerFromId(id) {
  if (id.startsWith('cline-pass/')) return 'cline';
  if (id.startsWith('opencode-go/')) return 'opencode-go';
  if (id.startsWith('opencode/')) return 'opencode-zen';
  if (id.startsWith('claude-') || id.startsWith('anthropic.')) return 'anthropic';
  if (id.startsWith('gemini-') || id.includes('google')) return 'google';
  if (id.startsWith('opencode-')) return 'opencode';
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
  if (id.startsWith('kimi-') || id === 'k3' || id.startsWith('k3-')) return 'moonshotai';
  if (id.startsWith('glm-')) return 'zhipu';
  return '';
}

function inferModelOwnerFromProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'gemini') return 'google';
  if (provider === 'codex') return 'openai';
  if (provider === 'opencode') return 'opencode';
  if (provider === 'kimi') return 'moonshotai';
  if (provider === 'zcode') return 'zhipu';
  if (provider === 'cline') return 'cline';
  return '';
}

function buildOpenAIModelsList(models) {
  const now = Math.floor(Date.now() / 1000);
  const safe = Array.isArray(models) ? models : [];
  return {
    object: 'list',
    data: safe.map((item) => {
      const id = typeof item === 'string' ? item : (item.id || '');
      const provider = typeof item === 'object' ? item.provider : '';
      const owned_by = inferModelOwnerFromId(id)
        || inferModelOwnerFromProvider(provider)
        || 'aih-server';

      const reasoningEfforts = resolveModelEfforts({ provider, model: id });
      const modelObj = {
        id,
        object: 'model',
        created: now,
        owned_by,
        // Modality index (input/output) so clients can pick vision/image-out
        // capable models without probing. Backed by models.dev metadata with
        // conservative family fallbacks (see model-modality-index.js).
        aih_modalities: getModelModalities(id, { provider }),
        // 推理强度档位：外部 harness（opencode / pi）据此渲染强度选择器。
        // 不发布这一项时，它们只能用自己的默认上限 —— 用户看到的就是「最大只能选 high」，
        // 而网关其实支持到 xhigh / max（2026-10-22 用户反馈）。
        // 查不到档位的模型不写该字段（省略 = 未知，而不是「没有档位」）。
        ...(reasoningEfforts.length > 0 ? { aih_reasoning_efforts: reasoningEfforts } : {})
      };

      // NOTE: Apart from aih_modalities we strip other custom metadata fields
      // (like aih_metadata) from the final model object. Strict clients like
      // Claude Code (anthropic-ai/claude-code) may reject models with
      // unrecognized schema fields.
      return modelObj;
    })
  };
}

module.exports = {
  FALLBACK_MODELS,
  initModelRegistry,
  addModelToRegistry,
  getRegistryModelList,
  buildOpenAIModelsList
};
