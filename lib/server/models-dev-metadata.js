'use strict';

const { createHash } = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { normalizeModelId } = require('./model-id');

const DEFAULT_MODELS_DEV_CATALOG_PATH = nodePath.resolve(
  __dirname,
  '..',
  '..',
  'data',
  'models-dev',
  'catalog.json'
);
const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
const MODELS_DEV_SNAPSHOT_SCHEMA_VERSION = 1;
const COST_PER_MILLION_TOKENS = 1_000_000;

let defaultCatalogSnapshot;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBool(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTextList(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item))
    .filter(Boolean)));
}

function normalizeReasoningOptions(value) {
  return (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .map((item) => {
      const type = normalizeText(item.type);
      if (!type) return null;
      const out = { type };
      const values = normalizeTextList(item.values);
      if (values.length > 0) out.values = values;
      const min = normalizeNumber(item.min);
      const max = normalizeNumber(item.max);
      if (min !== null) out.min = min;
      if (max !== null) out.max = max;
      return out;
    })
    .filter(Boolean);
}

function cleanObject(value) {
  const source = isRecord(value) ? value : {};
  const out = {};
  Object.entries(source).forEach(([key, item]) => {
    if (item === null || item === undefined || item === '') return;
    if (Array.isArray(item) && item.length < 1) return;
    if (isRecord(item)) {
      const nested = cleanObject(item);
      if (Object.keys(nested).length < 1) return;
      out[key] = nested;
      return;
    }
    out[key] = item;
  });
  return out;
}

function normalizeCostTier(rawTier) {
  const tier = isRecord(rawTier) ? rawTier : {};
  return cleanObject({
    input: normalizeNumber(tier.input),
    output: normalizeNumber(tier.output),
    reasoning: normalizeNumber(tier.reasoning),
    cacheRead: normalizeNumber(tier.cache_read),
    cacheWrite: normalizeNumber(tier.cache_write),
    inputAudio: normalizeNumber(tier.input_audio),
    outputAudio: normalizeNumber(tier.output_audio),
    tier: isRecord(tier.tier) ? cleanObject(tier.tier) : undefined
  });
}

function normalizeCost(rawCost) {
  const cost = isRecord(rawCost) ? rawCost : {};
  return cleanObject({
    input: normalizeNumber(cost.input),
    output: normalizeNumber(cost.output),
    reasoning: normalizeNumber(cost.reasoning),
    cacheRead: normalizeNumber(cost.cache_read),
    cacheWrite: normalizeNumber(cost.cache_write),
    inputAudio: normalizeNumber(cost.input_audio),
    outputAudio: normalizeNumber(cost.output_audio),
    tiers: Array.isArray(cost.tiers)
      ? cost.tiers.map(normalizeCostTier).filter((item) => Object.keys(item).length > 0)
      : undefined,
    contextOver200k: isRecord(cost.context_over_200k)
      ? {
          input: normalizeNumber(cost.context_over_200k.input),
          output: normalizeNumber(cost.context_over_200k.output),
          cacheRead: normalizeNumber(cost.context_over_200k.cache_read),
          cacheWrite: normalizeNumber(cost.context_over_200k.cache_write)
        }
      : undefined
  });
}

function normalizeMetadata(raw, source) {
  const model = isRecord(raw) ? raw : {};
  return cleanObject({
    id: normalizeText(source && source.modelId),
    providerId: normalizeText(source && source.providerId),
    baseModel: normalizeText(source && source.baseModel),
    source: {
      type: 'models.dev',
      url: normalizeText(source && source.url) || MODELS_DEV_CATALOG_URL,
      path: normalizeText(source && source.relativePath)
    },
    name: normalizeText(model.name),
    family: normalizeText(model.family),
    status: normalizeText(model.status),
    experimental: normalizeBool(model.experimental),
    dates: {
      release: normalizeText(model.release_date),
      lastUpdated: normalizeText(model.last_updated),
      knowledge: normalizeText(model.knowledge)
    },
    capabilities: {
      attachment: normalizeBool(model.attachment),
      reasoning: normalizeBool(model.reasoning),
      reasoningOptions: normalizeReasoningOptions(model.reasoning_options),
      toolCall: normalizeBool(model.tool_call),
      structuredOutput: normalizeBool(model.structured_output),
      temperature: normalizeBool(model.temperature),
      openWeights: normalizeBool(model.open_weights)
    },
    limits: {
      context: normalizeNumber(model.limit && model.limit.context),
      input: normalizeNumber(model.limit && model.limit.input),
      output: normalizeNumber(model.limit && model.limit.output)
    },
    modalities: {
      input: normalizeTextList(model.modalities && model.modalities.input),
      output: normalizeTextList(model.modalities && model.modalities.output)
    },
    cost: normalizeCost(model.cost),
    interleaved: isRecord(model.interleaved)
      ? cleanObject({ field: normalizeText(model.interleaved.field) })
      : undefined
  });
}

function costPerMillionToPerToken(value) {
  const number = normalizeNumber(value);
  return number === null ? null : number / COST_PER_MILLION_TOKENS;
}

function normalizePricingTierFromModelsDevCost(rawTier) {
  const tier = isRecord(rawTier) ? rawTier : {};
  const tierSpec = isRecord(tier.tier) ? tier.tier : {};
  const size = normalizeNumber(tierSpec.size);
  if (!size) return null;
  return cleanObject({
    size,
    inputCostPerToken: costPerMillionToPerToken(tier.input),
    outputCostPerToken: costPerMillionToPerToken(tier.output),
    cacheReadInputTokenCost: costPerMillionToPerToken(tier.cache_read),
    cacheCreationInputTokenCost: costPerMillionToPerToken(tier.cache_write),
    reasoningOutputTokenCost: costPerMillionToPerToken(tier.reasoning)
  });
}

function normalizePricingRecordFromModelsDevCost(model, rawCost) {
  const cost = isRecord(rawCost) ? rawCost : {};
  const hasDeclaredCost = [
    'input',
    'output',
    'reasoning',
    'cache_read',
    'cache_write'
  ].some((key) => normalizeNumber(cost[key]) !== null)
    || (Array.isArray(cost.tiers) && cost.tiers.length > 0);
  const record = cleanObject({
    model,
    inputCostPerToken: costPerMillionToPerToken(cost.input),
    outputCostPerToken: costPerMillionToPerToken(cost.output),
    cacheReadInputTokenCost: costPerMillionToPerToken(cost.cache_read),
    cacheCreationInputTokenCost: costPerMillionToPerToken(cost.cache_write),
    reasoningOutputTokenCost: costPerMillionToPerToken(cost.reasoning),
    contextCostTiers: Array.isArray(cost.tiers)
      ? cost.tiers.map(normalizePricingTierFromModelsDevCost).filter(Boolean)
      : undefined
  });
  if (!record.model) return null;
  if (!hasDeclaredCost) return null;
  return record;
}

function resolveCatalogDocument(document) {
  if (!isRecord(document)) return null;
  const wrapped = isRecord(document.catalog);
  const catalog = wrapped ? document.catalog : document;
  if (wrapped) {
    const source = document.source;
    const sha256 = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    if (
      document.schemaVersion !== MODELS_DEV_SNAPSHOT_SCHEMA_VERSION
      || !isRecord(source)
      || source.url !== MODELS_DEV_CATALOG_URL
      || source.sha256 !== sha256
    ) {
      return null;
    }
  }
  if (!isRecord(catalog.models) || !isRecord(catalog.providers)) return null;
  if (Object.keys(catalog.models).length < 1 || Object.keys(catalog.providers).length < 1) {
    return null;
  }
  return {
    catalog,
    url: wrapped ? document.source.url : MODELS_DEV_CATALOG_URL
  };
}

function loadModelsDevCatalog(deps = {}) {
  if (deps.modelsDevCatalog) return resolveCatalogDocument(deps.modelsDevCatalog);

  const fs = deps.fs || nodeFs;
  const catalogPath = nodePath.resolve(String(
    deps.modelsDevCatalogPath || DEFAULT_MODELS_DEV_CATALOG_PATH
  ));
  const useDefaultCache = fs === nodeFs && catalogPath === DEFAULT_MODELS_DEV_CATALOG_PATH;
  const forceReload = deps.forceReload === true;
  if (useDefaultCache && !forceReload && defaultCatalogSnapshot !== undefined) {
    return defaultCatalogSnapshot;
  }

  let loaded = null;
  try {
    if (fs.existsSync(catalogPath)) {
      loaded = resolveCatalogDocument(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
    }
  } catch (_error) {
    loaded = null;
  }
  if (useDefaultCache) defaultCatalogSnapshot = loaded;
  return loaded;
}

function buildModelsDevPricingRecords(deps = {}) {
  const loaded = loadModelsDevCatalog(deps);
  if (!loaded) return [];

  const records = [];
  Object.keys(loaded.catalog.providers).sort().forEach((providerId) => {
    const provider = loaded.catalog.providers[providerId];
    const models = isRecord(provider && provider.models) ? provider.models : {};
    Object.keys(models).sort().forEach((modelId) => {
      const record = normalizePricingRecordFromModelsDevCost(
        `${providerId}/${modelId}`,
        models[modelId] && models[modelId].cost
      );
      if (record) records.push(record);
    });
  });
  return records;
}

function stripKnownModelPrefix(modelId) {
  const id = normalizeText(modelId);
  if (id.startsWith('opencode-go/')) return id.slice('opencode-go/'.length);
  if (id.startsWith('opencode/')) return id.slice('opencode/'.length);
  return id;
}

function inferBaseModelIds(modelId) {
  const id = normalizeText(modelId);
  const stripped = stripKnownModelPrefix(id);
  const candidates = [];
  if (id.includes('/')) candidates.push(id);
  if (/^(gpt-|o\d|chatgpt-|text-embedding-)/i.test(stripped)) candidates.push(`openai/${stripped}`);
  if (/^claude-/i.test(stripped)) candidates.push(`anthropic/${stripped}`);
  if (/^(gemini-|gemma-)/i.test(stripped)) candidates.push(`google/${stripped}`);
  if (/^grok-/i.test(stripped)) candidates.push(`xai/${stripped}`);
  if (/^kimi-/i.test(stripped)) candidates.push(`moonshotai/${stripped}`);
  if (/^glm-/i.test(stripped)) candidates.push(`zhipuai/${stripped}`, `zhipu/${stripped}`);
  return Array.from(new Set(candidates));
}

function inferModelsDevProviderIds(aihProvider, modelId) {
  const provider = normalizeText(aihProvider).toLowerCase();
  const id = normalizeText(modelId);
  const stripped = stripKnownModelPrefix(id);
  const candidates = [];

  if (id.startsWith('opencode-go/')) candidates.push('opencode-go');
  if (id.startsWith('opencode/')) candidates.push('opencode');

  if (provider === 'codex') candidates.push('openai', 'github-copilot');
  if (provider === 'claude') candidates.push('anthropic');
  if (provider === 'gemini') candidates.push('google', 'google-vertex');
  if (provider === 'opencode') candidates.push('opencode-go', 'opencode');
  if (provider === 'agy') {
    if (/^claude-/i.test(stripped)) candidates.push('anthropic', 'github-copilot', 'google-vertex');
    if (/^(gemini-|gemma-)/i.test(stripped)) candidates.push('google', 'github-copilot', 'google-vertex');
    if (/^(gpt-|o\d|chatgpt-)/i.test(stripped)) candidates.push('openai', 'github-copilot');
    if (/^grok-/i.test(stripped)) candidates.push('xai');
    candidates.push('github-copilot');
  }
  // kimi OAuth(api.kimi.com/coding)模型挂在 kimi-for-coding provider；
  // api-key(api.moonshot.cn)模型对应 moonshotai-cn/moonshotai。
  if (provider === 'kimi') candidates.push('kimi-for-coding', 'moonshotai-cn', 'moonshotai');
  if (/^kimi-for-coding/i.test(stripped) || /^k3(?:-|$)/i.test(stripped)) {
    candidates.push('kimi-for-coding');
  }
  // zcode 的 GLM 模型挂在 Z.AI/智谱 Coding Plan provider；
  // opencode-go/glm-* 不混入该候选。
  if (provider === 'zcode' || (!provider && /^glm-/i.test(stripped))) {
    candidates.push('zai-coding-plan', 'zhipuai-coding-plan', 'zai', 'zhipuai');
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function buildNormalizedIndex(records) {
  const index = new Map();
  Object.entries(isRecord(records) ? records : {}).forEach(([id, record]) => {
    const key = normalizeModelId(id);
    if (key && isRecord(record) && !index.has(key)) index.set(key, { id, record });
  });
  return index;
}

function createModelsDevReader(deps = {}) {
  const loaded = loadModelsDevCatalog(deps);
  if (!loaded) return { resolveEntry: () => null };

  const { catalog, url } = loaded;
  const canonicalIndex = buildNormalizedIndex(catalog.models);
  const providerIndexes = new Map();

  function getProviderIndex(providerId) {
    const provider = normalizeText(providerId);
    if (!provider) return null;
    if (!providerIndexes.has(provider)) {
      const providerRecord = catalog.providers[provider];
      providerIndexes.set(
        provider,
        providerRecord ? buildNormalizedIndex(providerRecord.models) : null
      );
    }
    return providerIndexes.get(provider);
  }

  function findCanonicalModel(modelId) {
    return canonicalIndex.get(normalizeModelId(modelId)) || null;
  }

  function inferCanonicalModelId(providerId, modelId) {
    const stripped = stripKnownModelPrefix(modelId);
    const candidates = [
      ...inferBaseModelIds(modelId),
      `${providerId}/${stripped}`
    ];
    for (const candidate of candidates) {
      const match = findCanonicalModel(candidate);
      if (match) return match.id;
    }
    return '';
  }

  function readProviderModel(providerId, modelId) {
    const provider = normalizeText(providerId);
    const id = stripKnownModelPrefix(modelId);
    const index = getProviderIndex(provider);
    const match = index && index.get(normalizeModelId(id));
    if (!match) return null;
    return normalizeMetadata(match.record, {
      providerId: provider,
      modelId: normalizeText(modelId),
      baseModel: inferCanonicalModelId(provider, modelId),
      relativePath: `providers/${provider}/models/${match.id}`,
      url
    });
  }

  function readBaseModel(baseModelId, requestedModelId) {
    const match = findCanonicalModel(baseModelId);
    if (!match) return null;
    return normalizeMetadata(match.record, {
      modelId: normalizeText(requestedModelId) || match.id,
      baseModel: match.id,
      relativePath: `models/${match.id}`,
      url
    });
  }

  function resolveEntry(entry) {
    const modelId = normalizeText(entry && (entry.id || entry.model || entry.modelId));
    if (!modelId) return null;

    const providers = inferModelsDevProviderIds(entry && entry.provider, modelId);
    for (const provider of providers) {
      const providerModel = readProviderModel(provider, modelId);
      if (providerModel) return providerModel;
    }

    for (const baseModelId of inferBaseModelIds(modelId)) {
      const baseModel = readBaseModel(baseModelId, modelId);
      if (baseModel) return baseModel;
    }

    return null;
  }

  return { resolveEntry };
}

function buildModelMetadataMap(entries, deps = {}) {
  const reader = createModelsDevReader(deps);
  const out = {};
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const id = normalizeText(entry && (entry.id || entry.model || entry.modelId));
    if (!id || out[id]) return;
    const metadata = reader.resolveEntry(entry);
    if (metadata) out[id] = metadata;
  });
  return out;
}

function attachModelMetadata(items, deps = {}) {
  const source = Array.isArray(items) ? items : [];
  const reader = createModelsDevReader(deps);
  return source.map((item) => {
    const metadata = reader.resolveEntry(item);
    return metadata ? { ...item, metadata } : item;
  });
}

module.exports = {
  DEFAULT_MODELS_DEV_CATALOG_PATH,
  MODELS_DEV_CATALOG_URL,
  attachModelMetadata,
  buildModelsDevPricingRecords,
  buildModelMetadataMap,
  createModelsDevReader,
  inferBaseModelIds,
  inferModelsDevProviderIds,
  __private: {
    loadModelsDevCatalog,
    normalizeMetadata,
    normalizePricingRecordFromModelsDevCost,
    resolveCatalogDocument,
    stripKnownModelPrefix
  }
};
