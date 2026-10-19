'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const modelsDevSdkSnapshot = require('@opencode-ai/models/snapshot');
const { normalizeModelId } = require('./model-id');

// models.dev 元数据的唯一权威来源是 @opencode-ai/models SDK 自带的离线快照；
// 仓库不再 vendored catalog.json，package.json 钉精确版本。
const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
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
  // 只接受裸 { models, providers }：旧的 {schemaVersion, source, catalog} 包装格式
  // 随 vendored 快照一并移除，来源完整性由 package.json 钉住的 SDK 精确版本保证。
  if (!isRecord(document)) return null;
  if (!isRecord(document.models) || !isRecord(document.providers)) return null;
  if (Object.keys(document.models).length < 1 || Object.keys(document.providers).length < 1) {
    return null;
  }
  return { catalog: document, url: MODELS_DEV_CATALOG_URL };
}

function loadModelsDevCatalog(deps = {}) {
  if (deps.modelsDevCatalog) return resolveCatalogDocument(deps.modelsDevCatalog);

  // 显式注入路径是测试与排障覆盖通道；生产默认走 SDK 离线快照。
  if (deps.modelsDevCatalogPath) {
    const fs = deps.fs || nodeFs;
    const catalogPath = nodePath.resolve(String(deps.modelsDevCatalogPath));
    let loaded = null;
    try {
      if (fs.existsSync(catalogPath)) {
        loaded = resolveCatalogDocument(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
      }
    } catch (_error) {
      loaded = null;
    }
    return loaded;
  }

  if (defaultCatalogSnapshot === undefined || deps.forceReload === true) {
    defaultCatalogSnapshot = resolveCatalogDocument({
      models: modelsDevSdkSnapshot.models,
      providers: modelsDevSdkSnapshot.providers
    });
  }
  return defaultCatalogSnapshot;
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

function modelIdVariants(modelId) {
  const stripped = stripKnownModelPrefix(modelId);
  const variants = [stripped];
  // 版本点号与能力/档位后缀：claude-sonnet-4.5 / claude-opus-4-8[1m] 这类
  // provider 自定义写法在目录里不存在，先派生等价形态再做基座查找。
  const versionNormalized = stripped.replace(/(\d)\.(?=\d)/g, '$1-');
  if (versionNormalized !== stripped) variants.push(versionNormalized);
  const withoutBracketSuffix = stripped.replace(/\[[^\]]+\]$/i, '');
  if (withoutBracketSuffix !== stripped) variants.push(withoutBracketSuffix);
  const withoutDateTag = stripped.replace(/:\d{4}$/, '');
  if (withoutDateTag !== stripped) variants.push(withoutDateTag);
  return Array.from(new Set(variants));
}

function inferBaseModelIds(modelId) {
  const id = normalizeText(modelId);
  const stripped = stripKnownModelPrefix(id);
  const candidates = [];
  if (id.includes('/')) candidates.push(id);
  for (const variant of modelIdVariants(id)) {
    if (/^(gpt-|o\d|chatgpt-|text-embedding-)/i.test(variant)) candidates.push(`openai/${variant}`);
    if (/^claude-/i.test(variant)) candidates.push(`anthropic/${variant}`);
    if (/^(gemini-|gemma-)/i.test(variant)) candidates.push(`google/${variant}`);
    if (/^grok-/i.test(variant)) candidates.push(`xai/${variant}`);
    if (/^kimi-/i.test(variant)) candidates.push(`moonshotai/${variant}`);
    if (/^glm-/i.test(variant)) candidates.push(`zhipuai/${variant}`, `zhipu/${variant}`);
    // 非 Anthropic/OpenAI 系的开放模型：目录里同样以“厂牌/模型名”两级登记。
    if (/^deepseek-/i.test(variant)) candidates.push(`deepseek/${variant}`);
    if (/^minimax-/i.test(variant)) candidates.push(`minimax/${variant}`);
    if (/^qwen/i.test(variant)) candidates.push(`alibaba/${variant}`, `qwen/${variant}`);
    if (/^mimo-/i.test(variant)) candidates.push(`xiaomi/${variant}`);
    if (/^step-/i.test(variant)) candidates.push(`stepfun/${variant}`);
    if (/^nemotron-/i.test(variant)) candidates.push(`nvidia/${variant}`);
    if (/^mistral-/i.test(variant)) candidates.push(`mistralai/${variant}`);
  }
  // 能力/档位后缀变体（…-thinking、…-high、…-extra-low、…-agent）：provider 自定义
  // id 在固定目录里不存在。逐步裁掉尾段作为最低优先级候选，落到基座模型的元数据
  // （modalities/context window）；上面的精确候选永远先命中（如 kimi-k2-thinking 本体）。
  const prefixes = ['openai', 'anthropic', 'google', 'xai', 'moonshotai', 'zhipuai', 'zhipu', 'deepseek', 'minimax', 'alibaba', 'qwen', 'xiaomi', 'stepfun'];
  for (const variant of modelIdVariants(id)) {
    let trimmed = variant;
    while (trimmed.includes('-')) {
      trimmed = trimmed.slice(0, trimmed.lastIndexOf('-'));
      if (!trimmed) break;
      for (const prefix of prefixes) candidates.push(`${prefix}/${trimmed}`);
      if (trimmed.includes('/')) candidates.push(trimmed);
    }
  }
  return Array.from(new Set(candidates));
}

// CodeBuddy 家族把底层模型以裸名暴露（没有 provider 前缀），而 models.dev 里同模型只挂在
// 第三方目录下。这里只登记**能确认是同一模型**的裸名；`default-model` / `auto` 这类
// 由客户端二次选择的别名没有可对齐的底层模型，保持 unknown，不猜。
const CODEBUDDY_FAMILY_MODEL_RULES = Object.freeze([
  Object.freeze({
    pattern: /^deepseek-v4\.1-flash(?:$|[-:])/i,
    candidates: Object.freeze(['opencode-go'])
  }),
  Object.freeze({
    pattern: /^hy4-preview$/i,
    candidates: Object.freeze(['tencent-token-plan'])
  })
]);

// **models.dev 目录 provider 候选表**（数据）：把 aih 的 provider 映射到 models.dev 的目录 ID。
// 这是**外部目录的命名事实**（不是 aih 的 provider 能力），所以住在这一层而不是描述符里；
// 新增 provider 只加一行，派发处不写 provider 名比较。
// 分两段（与历史候选顺序一致）：先 provider 主候选，再按模型族的后置候选。
const MODELS_DEV_PROVIDER_CANDIDATES = Object.freeze({
  codex: Object.freeze(['openai', 'github-copilot']),
  claude: Object.freeze(['anthropic']),
  gemini: Object.freeze(['google', 'google-vertex']),
  opencode: Object.freeze(['opencode-go', 'opencode']),
  // cline 的会话模型 ID 自带 `cline-pass/` 前缀（如 `cline-pass/deepseek-v4-pro`），
  // models.dev 的 Cline Pass 目录也使用 `cline-pass/<model>` 的双段形式。
  cline: Object.freeze(['cline-pass']),
  // 家族四支客户端共享同一套模型命名与额度口径；规则表只登记裸名到目录的映射。
  codebuddy: Object.freeze({ rules: CODEBUDDY_FAMILY_MODEL_RULES }),
  codebuddycn: Object.freeze({ rules: CODEBUDDY_FAMILY_MODEL_RULES }),
  workbuddy: Object.freeze({ rules: CODEBUDDY_FAMILY_MODEL_RULES }),
  workbuddycn: Object.freeze({ rules: CODEBUDDY_FAMILY_MODEL_RULES }),
  // agy 是按模型族猜的：同一账号可能代理多家上游，因此按 ID 前缀给候选。
  agy: Object.freeze({
    rules: Object.freeze([
      Object.freeze({ pattern: /^claude-/i, candidates: Object.freeze(['anthropic', 'github-copilot', 'google-vertex']) }),
      Object.freeze({ pattern: /^(gemini-|gemma-)/i, candidates: Object.freeze(['google', 'github-copilot', 'google-vertex']) }),
      Object.freeze({ pattern: /^(gpt-|o\d|chatgpt-)/i, candidates: Object.freeze(['openai', 'github-copilot']) }),
      Object.freeze({ pattern: /^grok-/i, candidates: Object.freeze(['xai']) })
    ]),
    fallback: Object.freeze(['github-copilot'])
  }),
  // xAI 的 Grok 目录只登记在 xai 下；github-copilot 是同一模型的第二来源。
  grok: Object.freeze(['xai', 'github-copilot']),
  // kimi OAuth(api.kimi.com/coding) 模型挂在 kimi-code-plan-* provider；
  // api-key(api.moonshot.cn) 模型对应 moonshotai-cn/moonshotai。
  // `kimi-for-coding` 是 0.0.109 前的目录 ID，保留在末尾用于读取旧快照/旧 fixture。
  kimi: Object.freeze(['kimi-code-plan-global', 'kimi-code-plan-cn', 'moonshotai-cn', 'moonshotai', 'kimi-for-coding'])
});

// 后置候选（按模型族，与 provider 主候选分开以保持历史顺序）。
const MODELS_DEV_LATE_CANDIDATES = Object.freeze({
  // zcode 的 GLM 模型挂在 Z.AI/智谱 Coding Plan provider。
  zcode: Object.freeze(['zai-coding-plan', 'zhipuai-coding-plan', 'zai', 'zhipuai'])
});

// 没有 provider 上下文时按模型族猜目录（GLM → Z.AI/智谱 Coding Plan）。
const MODELS_DEV_MODEL_ID_LATE_RULES = Object.freeze([
  Object.freeze({ pattern: /^kimi-for-coding/i, candidates: Object.freeze(['kimi-code-plan-global', 'kimi-code-plan-cn', 'kimi-for-coding']) }),
  Object.freeze({ pattern: /^k3(?:-|$)/i, candidates: Object.freeze(['kimi-code-plan-global', 'kimi-code-plan-cn', 'kimi-for-coding']) }),
  Object.freeze({ pattern: /^glm-/i, candidates: MODELS_DEV_LATE_CANDIDATES.zcode })
]);

function inferModelsDevProviderIds(aihProvider, modelId) {
  const provider = normalizeText(aihProvider).toLowerCase();
  const id = normalizeText(modelId);
  const stripped = stripKnownModelPrefix(id);
  const candidates = [];

  if (id.startsWith('opencode-go/')) candidates.push('opencode-go');
  if (id.startsWith('opencode/')) candidates.push('opencode');

  const entry = MODELS_DEV_PROVIDER_CANDIDATES[provider];
  if (Array.isArray(entry)) {
    candidates.push(...entry);
  } else if (entry && Array.isArray(entry.rules)) {
    // 多上游代理型 provider：按模型族给候选，命中不了再用兜底。
    for (const rule of entry.rules) {
      if (rule.pattern.test(stripped)) candidates.push(...rule.candidates);
    }
    candidates.push(...(entry.fallback || []));
  }

  // 后置：provider 自己的模型族候选，以及没有 provider 时的模型族猜测。
  const late = MODELS_DEV_LATE_CANDIDATES[provider];
  if (Array.isArray(late)) {
    for (const rule of MODELS_DEV_MODEL_ID_LATE_RULES) {
      if (rule.pattern.test(stripped)) candidates.push(...rule.candidates);
    }
    candidates.push(...late);
    return Array.from(new Set(candidates.filter(Boolean)));
  }
  if (!provider) {
    for (const rule of MODELS_DEV_MODEL_ID_LATE_RULES) {
      if (rule.pattern.test(stripped)) candidates.push(...rule.candidates);
    }
  } else {
    // 非 zcode 的 provider 仍要走 kimi 族的后置候选（历史上无条件生效）。
    for (const rule of MODELS_DEV_MODEL_ID_LATE_RULES.slice(0, 2)) {
      if (rule.pattern.test(stripped)) candidates.push(...rule.candidates);
    }
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
    const metadata = normalizeMetadata(match.record, {
      modelId: normalizeText(requestedModelId) || match.id,
      baseModel: match.id,
      relativePath: `models/${match.id}`,
      url
    });
    // 规范模型（catalog.models）只携带模态/上下文等共享信息，价格挂在 provider
    // 记录上。能力后缀变体（-thinking、[1m]、版本点号）最终落到这里时，从基座
    // 模型所属厂牌的目录记录补一次价格；具体 provider 记录永远先于本兜底命中。
    if (metadata && !metadata.cost && match.id.includes('/')) {
      const slash = match.id.indexOf('/');
      const providerId = match.id.slice(0, slash);
      const providerModelId = match.id.slice(slash + 1);
      const providerModel = readProviderModel(providerId, providerModelId);
      if (providerModel && providerModel.cost) metadata.cost = providerModel.cost;
    }
    return metadata;
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
