'use strict';

// Model modality (capability) index. Answers "does this model accept image
// input (vision)?" / "does it emit image output?" for gateway features such as
// /v1/models capability filtering. Primary data source is the fixed
// models.dev catalog API snapshot read through models-dev-metadata;
// misses fall back to conservative model-family heuristics so unknown models
// degrade to text-only instead of guessing capabilities they may not have.

const { createModelsDevReader } = require('./models-dev-metadata');
const { listModelIdLookupKeys, normalizeModelId } = require('./model-id');
const { isImageGenerationModel } = require('./code-assist-image-generation');

const TEXT_MODALITY = 'text';
const IMAGE_MODALITY = 'image';

// Conservative vision-capable family list (input includes image) used only
// when models.dev has no record for the model. Patterns are tested against
// every lookup key (exact + version-separator-normalized), so both
// `gpt-4.1-mini` and `gpt-4-1-mini` match. Keep this table small and explicit;
// prefer adding models.dev metadata over widening a regex.
const VISION_INPUT_MODEL_PATTERNS = [
  /^claude-/,
  /^gemini-/,
  /^gpt-(4o|4[.-]1|5)/,
  /^o[13](?:$|[.-])/
];

const modalityCache = new Map();
// 上游探测(OAuth/API 实时 /models)拿到的 modalities 覆盖层:models.dev 快照。
// 同名模型可能被多个 Provider 使用，因此覆盖必须以 provider + model id 为键。
const probedModalityOverrides = new Map();
let sharedReader = null;

function getSharedReader() {
  if (!sharedReader) sharedReader = createModelsDevReader();
  return sharedReader;
}

function resolveModelsDevModalities(modelId, reader, provider) {
  for (const key of listModelIdLookupKeys(modelId)) {
    const metadata = reader.resolveEntry({ id: key, provider });
    const modalities = metadata && metadata.modalities;
    const input = Array.isArray(modalities && modalities.input) ? modalities.input : [];
    const output = Array.isArray(modalities && modalities.output) ? modalities.output : [];
    if (input.length > 0 || output.length > 0) {
      return {
        input: input.length > 0 ? input.slice() : [TEXT_MODALITY],
        output: output.length > 0 ? output.slice() : [TEXT_MODALITY]
      };
    }
  }
  return null;
}

function normalizeProbedModalities(value) {
  const input = Array.isArray(value && value.input) ? value.input : [];
  const output = Array.isArray(value && value.output) ? value.output : [];
  const cleanInput = input.map((item) => String(item || '').trim()).filter(Boolean);
  const cleanOutput = output.map((item) => String(item || '').trim()).filter(Boolean);
  if (cleanInput.length < 1 && cleanOutput.length < 1) return null;
  return {
    input: cleanInput.length > 0 ? cleanInput : [TEXT_MODALITY],
    output: cleanOutput.length > 0 ? cleanOutput : [TEXT_MODALITY]
  };
}

function buildProviderModelKey(providerRaw, modelIdRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  const lookupKeys = listModelIdLookupKeys(modelIdRaw);
  const modelId = lookupKeys[lookupKeys.length - 1] || '';
  return provider && modelId ? `${provider}|${modelId}` : '';
}

function registerProbedModelModalities(provider, descriptors) {
  (Array.isArray(descriptors) ? descriptors : []).forEach((descriptor) => {
    const id = normalizeModelId(descriptor && (descriptor.id || descriptor.modelId));
    const modalities = normalizeProbedModalities(descriptor && descriptor.modalities);
    const key = buildProviderModelKey(provider, id);
    if (!key || !modalities) return;
    probedModalityOverrides.set(key, modalities);
    modalityCache.delete(key);
  });
}

function buildFallbackModalities(modelId) {
  const input = [TEXT_MODALITY];
  const output = [TEXT_MODALITY];
  const keys = listModelIdLookupKeys(modelId);
  if (isImageGenerationModel(modelId)) output.push(IMAGE_MODALITY);
  const hasVisionFamily = keys.some((key) => (
    VISION_INPUT_MODEL_PATTERNS.some((pattern) => pattern.test(key))
  ));
  if (hasVisionFamily) input.push(IMAGE_MODALITY);
  return { input, output };
}

function computeModelModalities(modelId, deps = {}) {
  const override = probedModalityOverrides.get(buildProviderModelKey(deps.provider, modelId));
  if (override) return { input: override.input.slice(), output: override.output.slice() };
  const reader = deps.reader || getSharedReader();
  const modalities = resolveModelsDevModalities(modelId, reader, deps.provider) || buildFallbackModalities(modelId);
  if (isImageGenerationModel(modelId) && !modalities.input.includes(IMAGE_MODALITY)) {
    modalities.input.push(IMAGE_MODALITY);
  }
  return modalities;
}

function getModelModalities(modelId, deps = {}) {
  const id = normalizeModelId(modelId);
  if (!id) return { input: [TEXT_MODALITY], output: [TEXT_MODALITY] };
  if (deps.reader) return computeModelModalities(modelId, deps);
  const provider = String(deps.provider || '').trim().toLowerCase();
  const lookupKeys = listModelIdLookupKeys(id);
  const normalizedCacheId = lookupKeys[lookupKeys.length - 1] || id;
  const cacheKey = provider ? buildProviderModelKey(provider, id) : normalizedCacheId;
  let cached = modalityCache.get(cacheKey);
  if (!cached) {
    cached = computeModelModalities(modelId, deps);
    modalityCache.set(cacheKey, cached);
  }
  return { input: cached.input.slice(), output: cached.output.slice() };
}

function modelSupportsVision(modelId, deps = {}) {
  return getModelModalities(modelId, deps).input.includes(IMAGE_MODALITY);
}

function modelGeneratesImages(modelId, deps = {}) {
  return getModelModalities(modelId, deps).output.includes(IMAGE_MODALITY);
}

// Capability names used by `/v1/models?capability=...`. Unknown capability
// values do not filter (return true) so new/typo'd values fail open instead of
// hiding the whole catalog.
function modelMatchesCapability(modelId, capability, deps = {}) {
  const normalized = String(capability || '').trim().toLowerCase();
  if (normalized === 'vision') return modelSupportsVision(modelId, deps);
  if (normalized === 'image_out') return modelGeneratesImages(modelId, deps);
  return true;
}

function resetModelModalityCache() {
  modalityCache.clear();
  probedModalityOverrides.clear();
  sharedReader = null;
}

module.exports = {
  getModelModalities,
  modelGeneratesImages,
  modelMatchesCapability,
  modelSupportsVision,
  registerProbedModelModalities,
  __private: {
    VISION_INPUT_MODEL_PATTERNS,
    buildFallbackModalities,
    resetModelModalityCache
  }
};
