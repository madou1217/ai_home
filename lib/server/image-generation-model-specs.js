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
      capabilityOverrides: Object.freeze({ maxInputImages: 14, size: true })
    }),
    Object.freeze({ id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', priority: 50 })
  ]),
  gemini: Object.freeze([
    Object.freeze({
      id: 'gemini-3.1-flash-image',
      label: 'Gemini 3.1 Flash Image',
      priority: 20,
      capabilityOverrides: Object.freeze({ maxInputImages: 14, size: true })
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
    // 不带格式参数时上游的实际输出格式（历史出图实测 image/png）。请求恰好要这个格式
    // 不算格式控制，不应因 outputFormat=false 被拒。
    defaultOutputFormat: 'png',
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
    defaultOutputFormat: 'jpeg', // 历史出图实测 image/jpeg
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

// 生图模型自身的 prompt 硬上限（与 Provider 无关）。
//
// 只登记有实测证据的模型：gpt-image-2 的 Images 契约上限 32000 字符（2026-11-02 实测，
// 180k 字符被上游 400："Expected a string with maximum length 32000"）。按模型而不是
// 按 Provider 登记，是因为同一个模型既可能走原生策略（codex OAuth）也可能走透传上游
// （API-key 中转）——限额属于模型契约，两条路径都得拦。没有登记的模型一律不猜。
const IMAGE_PROMPT_LIMITS = Object.freeze({
  'gpt-image-2': 32000
});

function getImagePromptLimit(modelId) {
  return IMAGE_PROMPT_LIMITS[normalizeModelId(modelId)] || 0;
}

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

// GPT Image 家族（gpt-image-* / chatgpt-image-*，允许带命名空间前缀）不接受 response_format：
// OpenAI 文档把它标为只给已退役 DALL·E 用的旧参数，GPT Image 一律返回 base64。网关自己编码
// 的请求（Image Studio 等内部调用方）发给它就会被拒；其它模型（第三方兼容端点上的非 GPT 生图
// 模型）仍可能需要它来拿到 base64 而不是链接。
const GPT_IMAGE_MODEL_PATTERN = /^(?:[a-z0-9._-]+\/)?(?:gpt-image|chatgpt-image)(?:$|[-._])/i;

function acceptsResponseFormatParameter(modelId) {
  return !GPT_IMAGE_MODEL_PATTERN.test(normalizeModelId(modelId));
}

module.exports = {
  IMAGE_PROMPT_LIMITS,
  NATIVE_IMAGE_CAPABILITIES,
  NATIVE_IMAGE_MODEL_SPECS,
  acceptsResponseFormatParameter,
  getImagePromptLimit,
  getNativeImageCapabilities,
  getNativeImageQualityOptions,
  imageModelBelongsToProvider,
  listNativeImageModelSpecs,
  resolveNativeImageModelSpec
};
