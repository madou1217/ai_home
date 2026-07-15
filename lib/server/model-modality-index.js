'use strict';

// Model modality (capability) index. Answers "does this model accept image
// input (vision)?" / "does it emit image output?" for gateway features such as
// /v1/models capability filtering. Primary data source is the vendored
// models.dev metadata (third_party/models.dev TOML via models-dev-metadata);
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
  /^gemini-(?!.*image)/,
  /^gpt-(4o|4[.-]1|5)/,
  /^o[13](?:$|[.-])/
];

const modalityCache = new Map();
let sharedReader = null;

function getSharedReader() {
  if (!sharedReader) sharedReader = createModelsDevReader();
  return sharedReader;
}

function resolveModelsDevModalities(modelId, reader) {
  for (const key of listModelIdLookupKeys(modelId)) {
    const metadata = reader.resolveEntry({ id: key });
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
  const reader = deps.reader || getSharedReader();
  return resolveModelsDevModalities(modelId, reader) || buildFallbackModalities(modelId);
}

function getModelModalities(modelId, deps = {}) {
  const cacheKey = normalizeModelId(modelId);
  if (!cacheKey) return { input: [TEXT_MODALITY], output: [TEXT_MODALITY] };
  if (deps.reader) return computeModelModalities(modelId, deps);
  let cached = modalityCache.get(cacheKey);
  if (!cached) {
    cached = computeModelModalities(modelId);
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
  sharedReader = null;
}

module.exports = {
  getModelModalities,
  modelGeneratesImages,
  modelMatchesCapability,
  modelSupportsVision,
  __private: {
    VISION_INPUT_MODEL_PATTERNS,
    buildFallbackModalities,
    resetModelModalityCache
  }
};
