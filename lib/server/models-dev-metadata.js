'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { normalizeModelId } = require('./model-id');

const DEFAULT_MODELS_DEV_DIR = nodePath.resolve(__dirname, '..', '..', 'third_party', 'models.dev');
const MODELS_DEV_REPOSITORY = 'https://github.com/anomalyco/models.dev';
const COST_PER_MILLION_TOKENS = 1_000_000;

function stripTomlComment(line) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(value, separator = ',') {
  const out = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === separator && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

function parseTomlString(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value.slice(1, -1);
  }
}

function parseTomlInlineTable(value) {
  const inner = value.slice(1, -1).trim();
  const out = {};
  splitTopLevel(inner).forEach((part) => {
    const index = part.indexOf('=');
    if (index <= 0) return;
    const key = part.slice(0, index).trim();
    if (!key) return;
    out[key] = parseTomlValue(part.slice(index + 1).trim());
  });
  return out;
}

function parseTomlArray(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner).map(parseTomlValue);
}

function parseTomlValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) return parseTomlString(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) return parseTomlArray(value);
  if (value.startsWith('{') && value.endsWith('}')) return parseTomlInlineTable(value);
  if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?$/.test(value)) {
    const parsed = Number(value.replace(/_/g, ''));
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

function getTomlPathTarget(root, pathParts, createValue) {
  let target = root;
  for (let i = 0; i < pathParts.length; i += 1) {
    const part = pathParts[i];
    if (!part) return null;
    if (i === pathParts.length - 1) {
      if (!target[part]) target[part] = typeof createValue === 'function' ? createValue() : {};
      return target[part];
    }
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) {
      target[part] = {};
    }
    target = target[part];
  }
  return root;
}

function parseTomlPath(value) {
  return String(value || '')
    .split('.')
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldCaptureTomlArrayTable(pathParts) {
  const key = pathParts.join('.');
  return key === 'reasoning_options' || key === 'cost.tiers';
}

function parseTomlDocument(text) {
  const out = {};
  let sectionPath = [];
  let arrayTableTarget = null;
  let ignoredArrayTable = false;
  String(text || '').split(/\r?\n/).forEach((rawLine) => {
    const line = stripTomlComment(rawLine).trim();
    if (!line) return;
    const arraySectionMatch = line.match(/^\[\[([^\]]+)]]$/);
    if (arraySectionMatch) {
      sectionPath = parseTomlPath(arraySectionMatch[1]);
      arrayTableTarget = null;
      ignoredArrayTable = !shouldCaptureTomlArrayTable(sectionPath);
      if (ignoredArrayTable) return;
      const containerPath = sectionPath.slice(0, -1);
      const arrayKey = sectionPath[sectionPath.length - 1];
      const container = getTomlPathTarget(out, containerPath, () => ({}));
      if (!container || !arrayKey) {
        ignoredArrayTable = true;
        return;
      }
      if (!Array.isArray(container[arrayKey])) container[arrayKey] = [];
      arrayTableTarget = {};
      container[arrayKey].push(arrayTableTarget);
      return;
    }

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      sectionPath = parseTomlPath(sectionMatch[1]);
      arrayTableTarget = null;
      ignoredArrayTable = false;
      getTomlPathTarget(out, sectionPath, () => ({}));
      return;
    }

    const index = line.indexOf('=');
    if (index <= 0) return;
    if (ignoredArrayTable) return;
    const key = line.slice(0, index).trim();
    if (!key) return;
    const value = parseTomlValue(line.slice(index + 1).trim());
    if (arrayTableTarget) {
      arrayTableTarget[key] = value;
      return;
    }
    if (sectionPath.length < 1) {
      out[key] = value;
      return;
    }
    const target = getTomlPathTarget(out, sectionPath, () => ({}));
    if (target) target[key] = value;
  });
  return out;
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
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
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
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  Object.entries(source).forEach(([key, item]) => {
    if (item === null || item === undefined || item === '') return;
    if (Array.isArray(item) && item.length < 1) return;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
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
  const tier = rawTier && typeof rawTier === 'object' ? rawTier : {};
  return cleanObject({
    input: normalizeNumber(tier.input),
    output: normalizeNumber(tier.output),
    reasoning: normalizeNumber(tier.reasoning),
    cacheRead: normalizeNumber(tier.cache_read),
    cacheWrite: normalizeNumber(tier.cache_write),
    inputAudio: normalizeNumber(tier.input_audio),
    outputAudio: normalizeNumber(tier.output_audio),
    tier: tier.tier && typeof tier.tier === 'object' ? cleanObject(tier.tier) : undefined
  });
}

function normalizeCost(rawCost) {
  const cost = rawCost && typeof rawCost === 'object' ? rawCost : {};
  return cleanObject({
    input: normalizeNumber(cost.input),
    output: normalizeNumber(cost.output),
    reasoning: normalizeNumber(cost.reasoning),
    cacheRead: normalizeNumber(cost.cache_read),
    cacheWrite: normalizeNumber(cost.cache_write),
    inputAudio: normalizeNumber(cost.input_audio),
    outputAudio: normalizeNumber(cost.output_audio),
    tiers: Array.isArray(cost.tiers) ? cost.tiers.map(normalizeCostTier).filter((item) => Object.keys(item).length > 0) : undefined,
    contextOver200k: cost.context_over_200k && typeof cost.context_over_200k === 'object'
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
  const model = raw && typeof raw === 'object' ? raw : {};
  return cleanObject({
    id: normalizeText(source && source.modelId),
    providerId: normalizeText(source && source.providerId),
    baseModel: normalizeText(source && source.baseModel || model.base_model),
    source: {
      type: 'models.dev',
      repository: MODELS_DEV_REPOSITORY,
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
    interleaved: model.interleaved && typeof model.interleaved === 'object'
      ? cleanObject({ field: normalizeText(model.interleaved.field) })
      : undefined
  });
}

function mergeRawModel(base, override) {
  const left = base && typeof base === 'object' ? base : {};
  const right = override && typeof override === 'object' ? override : {};
  const out = { ...left, ...right };
  ['limit', 'modalities', 'cost', 'interleaved'].forEach((key) => {
    if (left[key] || right[key]) {
      out[key] = {
        ...(left[key] && typeof left[key] === 'object' ? left[key] : {}),
        ...(right[key] && typeof right[key] === 'object' ? right[key] : {})
      };
    }
  });
  return out;
}

function costPerMillionToPerToken(value) {
  const number = normalizeNumber(value);
  return number === null ? null : number / COST_PER_MILLION_TOKENS;
}

function normalizePricingTierFromModelsDevCost(rawTier) {
  const tier = rawTier && typeof rawTier === 'object' ? rawTier : {};
  const tierSpec = tier.tier && typeof tier.tier === 'object' ? tier.tier : {};
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
  const cost = rawCost && typeof rawCost === 'object' ? rawCost : {};
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
  if (
    !record.inputCostPerToken
    && !record.outputCostPerToken
    && !record.cacheReadInputTokenCost
    && !record.cacheCreationInputTokenCost
    && !record.reasoningOutputTokenCost
    && !record.contextCostTiers
  ) {
    return null;
  }
  return record;
}

function listTomlFiles(fs, dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      const filePath = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.toml')) out.push(filePath);
    });
  }
  return out.sort();
}

function modelIdFromTomlPath(root, filePath) {
  const relative = safeRelativePath(root, filePath);
  return relative.endsWith('.toml') ? relative.slice(0, -'.toml'.length) : relative;
}

function buildModelsDevPricingRecords(deps = {}) {
  const fs = deps.fs || nodeFs;
  const root = getModelsDevRoot(deps);
  const providersRoot = nodePath.join(root, 'providers');
  if (!fs.existsSync(providersRoot)) return [];
  const providerEntries = fs.readdirSync(providersRoot, { withFileTypes: true });
  const records = [];
  providerEntries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    const providerId = entry.name;
    const modelsRoot = nodePath.join(providersRoot, providerId, 'models');
    listTomlFiles(fs, modelsRoot).forEach((filePath) => {
      const parsed = readTomlFile(fs, root, filePath);
      const modelId = modelIdFromTomlPath(modelsRoot, filePath);
      const record = normalizePricingRecordFromModelsDevCost(`${providerId}/${modelId}`, parsed && parsed.data && parsed.data.cost);
      if (record) records.push(record);
    });
  });
  return records;
}

function getModelsDevRoot(deps = {}) {
  return nodePath.resolve(String(deps.modelsDevDir || DEFAULT_MODELS_DEV_DIR));
}

function safeRelativePath(root, filePath) {
  return nodePath.relative(root, filePath).split(nodePath.sep).join('/');
}

function readTomlFile(fs, root, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    path: filePath,
    relativePath: safeRelativePath(root, filePath),
    data: parseTomlDocument(text)
  };
}

function modelIdToFile(root, scope, modelId) {
  const id = normalizeText(modelId);
  if (!id || id.includes('..')) return '';
  return nodePath.join(root, scope, ...id.split('/')) + '.toml';
}

function providerModelIdToFile(root, providerId, modelId) {
  const provider = normalizeText(providerId);
  const id = normalizeText(modelId);
  if (!provider || !id || provider.includes('..') || id.includes('..')) return '';
  return nodePath.join(root, 'providers', provider, 'models', ...id.split('/')) + '.toml';
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

  return Array.from(new Set(candidates.filter(Boolean)));
}

function createModelsDevReader(deps = {}) {
  const fs = deps.fs || nodeFs;
  const root = getModelsDevRoot(deps);
  const rawCache = new Map();

  function readBaseModel(baseModelId, seen = new Set()) {
    const id = normalizeText(baseModelId);
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const cacheKey = `base:${id}`;
    if (rawCache.has(cacheKey)) return rawCache.get(cacheKey);
    const parsed = readTomlFile(fs, root, modelIdToFile(root, 'models', id));
    if (!parsed) {
      rawCache.set(cacheKey, null);
      return null;
    }
    const parent = parsed.data.base_model ? readBaseModel(parsed.data.base_model, seen) : null;
    const raw = parent ? mergeRawModel(parent.raw, parsed.data) : parsed.data;
    const result = {
      raw,
      source: {
        modelId: id,
        baseModel: normalizeText(parsed.data.base_model),
        relativePath: parsed.relativePath
      }
    };
    rawCache.set(cacheKey, result);
    return result;
  }

  function readProviderModel(providerId, modelId) {
    const provider = normalizeText(providerId);
    const id = stripKnownModelPrefix(modelId);
    if (!provider || !id) return null;
    const cacheKey = `provider:${provider}:${id}`;
    if (rawCache.has(cacheKey)) return rawCache.get(cacheKey);
    const parsed = readTomlFile(fs, root, providerModelIdToFile(root, provider, id));
    if (!parsed) {
      rawCache.set(cacheKey, null);
      return null;
    }
    const base = parsed.data.base_model ? readBaseModel(parsed.data.base_model) : null;
    const raw = base ? mergeRawModel(base.raw, parsed.data) : parsed.data;
    const result = {
      raw,
      source: {
        providerId: provider,
        modelId: normalizeText(modelId),
        baseModel: normalizeText(parsed.data.base_model),
        relativePath: parsed.relativePath
      }
    };
    rawCache.set(cacheKey, result);
    return result;
  }

  function resolveEntry(entry) {
    const modelId = normalizeText(entry && (entry.id || entry.model || entry.modelId));
    if (!modelId || !fs.existsSync(root)) return null;

    const providers = inferModelsDevProviderIds(entry && entry.provider, modelId);
    for (const provider of providers) {
      const providerModel = readProviderModel(provider, modelId);
      if (providerModel) return normalizeMetadata(providerModel.raw, providerModel.source);
    }

    for (const baseModelId of inferBaseModelIds(modelId)) {
      const baseModel = readBaseModel(baseModelId);
      if (baseModel) {
        return normalizeMetadata(baseModel.raw, {
          ...baseModel.source,
          modelId
        });
      }
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
  DEFAULT_MODELS_DEV_DIR,
  MODELS_DEV_REPOSITORY,
  attachModelMetadata,
  buildModelsDevPricingRecords,
  buildModelMetadataMap,
  createModelsDevReader,
  inferBaseModelIds,
  inferModelsDevProviderIds,
  parseTomlDocument,
  __private: {
    mergeRawModel,
    normalizeMetadata,
    normalizePricingRecordFromModelsDevCost,
    parseTomlValue,
    splitTopLevel,
    stripKnownModelPrefix
  }
};
