'use strict';

// Canonical public image-model intents owned by native provider strategies.
// These are intentionally separate from the provider's dialog-model catalog:
// Codex, for example, exposes only the dedicated `gpt-image-2` Images API
// contract here and must not inherit unrelated chat models.

const NATIVE_IMAGE_MODEL_SPECS = Object.freeze({
  codex: Object.freeze([
    Object.freeze({
      id: 'gpt-image-2',
      label: 'GPT Image 2',
      priority: 10,
      qualityOptions: Object.freeze(['low', 'medium', 'high'])
    })
  ]),
  agy: Object.freeze([
    Object.freeze({
      id: 'gemini-3.1-flash-image',
      label: 'Gemini 3.1 Flash Image',
      priority: 20,
      capabilityOverrides: Object.freeze({ maxInputImages: 14 })
    }),
    Object.freeze({ id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', priority: 50 })
  ]),
  gemini: Object.freeze([
    Object.freeze({
      id: 'gemini-3.1-flash-image',
      label: 'Gemini 3.1 Flash Image',
      priority: 20,
      capabilityOverrides: Object.freeze({ maxInputImages: 14 })
    }),
    Object.freeze({ id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', priority: 50 })
  ]),
  grok: Object.freeze([
    Object.freeze({
      id: 'grok-imagine-image-2.0',
      label: 'Grok Imagine Image 2.0',
      priority: 60,
      capabilityOverrides: Object.freeze({ quality: true, maxInputImages: 3 }),
      qualityOptions: Object.freeze(['low', 'medium'])
    }),
    Object.freeze({
      id: 'grok-imagine-image-quality',
      label: 'Grok Imagine Image Quality',
      priority: 65
    }),
    Object.freeze({ id: 'grok-imagine-image', label: 'Grok Imagine Image', priority: 70 })
  ])
});

const NATIVE_IMAGE_CAPABILITIES = Object.freeze({
  codex: Object.freeze({
    generation: true,
    edit: true,
    mask: false,
    multiple: true,
    size: true,
    quality: true,
    responseFormat: true,
    maxInputImages: 5,
    background: true,
    outputFormat: false,
    outputCompression: false,
    moderation: false
  }),
  agy: Object.freeze({
    generation: true,
    edit: true,
    mask: false,
    multiple: false,
    size: false,
    quality: false,
    responseFormat: true,
    maxInputImages: 1,
    background: false,
    outputFormat: false,
    outputCompression: false,
    moderation: false
  }),
  gemini: Object.freeze({
    generation: true,
    edit: true,
    mask: false,
    multiple: false,
    size: false,
    quality: false,
    responseFormat: true,
    maxInputImages: 1,
    background: false,
    outputFormat: false,
    outputCompression: false,
    moderation: false
  }),
  grok: Object.freeze({
    generation: true,
    edit: true,
    mask: false,
    multiple: true,
    size: false,
    quality: false,
    responseFormat: true,
    maxInputImages: 1,
    background: false,
    outputFormat: false,
    outputCompression: false,
    moderation: false
  }),
  passthrough: Object.freeze({
    generation: true,
    edit: true,
    mask: true,
    multiple: true,
    size: true,
    quality: true,
    responseFormat: true,
    maxInputImages: 16,
    background: true,
    outputFormat: true,
    outputCompression: true,
    moderation: true
  })
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeModelId(modelId) {
  return String(modelId || '').trim().toLowerCase();
}

function listNativeImageModelSpecs(provider) {
  const specs = NATIVE_IMAGE_MODEL_SPECS[normalizeProvider(provider)] || [];
  return specs.map((item) => ({
    ...item,
    ...(item.capabilityOverrides ? { capabilityOverrides: { ...item.capabilityOverrides } } : {}),
    ...(item.qualityOptions ? { qualityOptions: [...item.qualityOptions] } : {})
  }));
}

function resolveNativeImageModelSpec(provider, modelId) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModelId(modelId);
  if (!normalizedModel) return null;
  const specs = NATIVE_IMAGE_MODEL_SPECS[normalizedProvider] || [];
  const exact = specs.find((spec) => normalizeModelId(spec.id) === normalizedModel);
  if (exact) return exact;
  if (normalizedProvider === 'grok' && /^grok-(?:imagine-)?image-2(?:\.0)?$/i.test(normalizedModel)) {
    return specs.find((spec) => spec.id === 'grok-imagine-image-2.0') || null;
  }
  return null;
}

function getNativeImageCapabilities(provider, modelId = '') {
  const normalizedProvider = normalizeProvider(provider);
  const capabilities = NATIVE_IMAGE_CAPABILITIES[normalizedProvider];
  if (!capabilities) return null;
  const spec = resolveNativeImageModelSpec(normalizedProvider, modelId);
  return {
    ...capabilities,
    ...(spec && spec.capabilityOverrides ? spec.capabilityOverrides : {})
  };
}

function getNativeImageQualityOptions(provider, modelId = '') {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === 'passthrough') return ['low', 'medium', 'high'];
  const spec = resolveNativeImageModelSpec(normalizedProvider, modelId);
  return spec && Array.isArray(spec.qualityOptions) ? [...spec.qualityOptions] : [];
}

function imageModelBelongsToProvider(provider, modelId) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModelId(modelId);
  if (!normalizedModel) return false;
  if (normalizedProvider === 'codex') return normalizedModel === 'gpt-image-2';
  if (normalizedProvider === 'grok') return /^grok-(?:imagine-)?image(?:[-._].+)?$/i.test(normalizedModel);
  if (normalizedProvider === 'agy' || normalizedProvider === 'gemini') {
    return /^(?:google\/)?gemini[-_/].*image(?:[-._].*)?$/i.test(normalizedModel)
      || /nano-?banana/i.test(normalizedModel);
  }
  return false;
}

module.exports = {
  NATIVE_IMAGE_CAPABILITIES,
  NATIVE_IMAGE_MODEL_SPECS,
  getNativeImageCapabilities,
  getNativeImageQualityOptions,
  imageModelBelongsToProvider,
  listNativeImageModelSpecs,
  resolveNativeImageModelSpec
};
