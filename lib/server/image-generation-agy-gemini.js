'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { __private: { readInlineData } } = require('./code-assist-image-generation');
const {
  getNativeImageCapabilities,
  imageModelBelongsToProvider
} = require('./image-generation-model-specs');
const { extractGeminiCandidates } = require('./http-utils-normalize');
const { createModelUsageCapture } = require('./upstream-endpoints-usage');

// Native strategy for agy / gemini OAuth accounts: image models (e.g.
// `gemini-3.1-flash-image`) return the picture as an inlineData (base64) part
// when the request opts into the IMAGE response modality.
//
// The request is shaped in the native generateContent form:
//   { model, contents: [{ role: 'user', parts: [...] }], generationConfig }
// `buildNativeGeminiCodeAssistRequest` (inside fetchGeminiCodeAssistGenerateContent)
// preserves inlineData parts untouched (its repair pass only touches
// functionResponse parts), and the strategy forces `responseModalities:
// ['TEXT','IMAGE']` while neutralizing the default thinkingConfig (undefined is
// dropped by JSON.stringify, so the image model is not asked to narrate first).
//
// The default 8s timeout of the shared fetcher is far too short for image
// generation, so the strategy always passes an explicit timeout.

const DEFAULT_TIMEOUT_MS = 120000;

// OpenAI standard sizes and Open Design's aspect presets map to Gemini's
// native 1K output. Pixel dimensions remain provider-native; no resizing is
// performed. In particular, Open Design encodes its 16:9 preset as 1792x1024.
const IMAGE_SIZE_ASPECT_RATIOS = Object.freeze({
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
  '1408x1056': '4:3',
  '1056x1408': '3:4'
});

function buildGeminiImageConfig(size) {
  if (!size || size === 'auto') return undefined;
  const aspectRatio = IMAGE_SIZE_ASPECT_RATIOS[size];
  if (!aspectRatio) {
    throw new ImageGenerationError(400, 'unsupported_image_size',
      `gemini image size must be auto or one of ${Object.keys(IMAGE_SIZE_ASPECT_RATIOS).join(', ')}`);
  }
  return { aspectRatio, imageSize: '1K' };
}

function createAgyGeminiImageGenerationStrategy(deps = {}, providerName = 'agy') {
  const fetchGeminiCodeAssistGenerateContent = deps.fetchGeminiCodeAssistGenerateContent;
  const provider = String(providerName || '').trim().toLowerCase() === 'gemini' ? 'gemini' : 'agy';
  return {
    provider,
    kind: 'native',
    capabilities: getNativeImageCapabilities(provider),
    capabilitiesForModel(modelId) {
      return getNativeImageCapabilities(provider, modelId);
    },
    supportsModel(modelId) {
      return imageModelBelongsToProvider(provider, modelId);
    },
    async generate(input) {
      if (typeof fetchGeminiCodeAssistGenerateContent !== 'function') {
        throw new ImageGenerationError(500, 'agy_transport_unavailable', 'agy gemini transport is not configured');
      }
      const { mode, model, prompt, size, images: inputImages, account, options } = input;
      const imageConfig = buildGeminiImageConfig(size);
      const parts = [{ text: prompt }];
      if (mode === 'edit') {
        const inputs = Array.isArray(inputImages) ? inputImages : [];
        if (inputs.length < 1) throw new ImageGenerationError(400, 'image_required', 'image is required for image edits');
        inputs.forEach((image) => {
          parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        });
      }
      const requestJson = {
        model,
        contents: [{ role: 'user', parts }],
        // IMAGE modality is mandatory; undefined thinkingConfig removes the
        // default thinking budget so the model draws instead of narrating.
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(imageConfig ? { imageConfig } : {}),
          thinkingConfig: undefined
        }
      };
      const timeoutMs = Math.max(Number(options && options.upstreamTimeoutMs) || 0, DEFAULT_TIMEOUT_MS);

      let envelope;
      try {
        envelope = await fetchGeminiCodeAssistGenerateContent(
          options,
          account,
          requestJson,
          timeoutMs
        );
      } catch (error) {
        if (error && error.code === 'GEMINI_CODE_ASSIST_NOT_APPLICABLE') {
          throw new ImageGenerationError(400, 'gemini_code_assist_not_applicable', 'account cannot use gemini code assist');
        }
        const statusMatch = /^HTTP_(\d{3})$/i.exec(String(error && error.code || '').trim());
        const err = new ImageGenerationError(
          statusMatch ? Number(statusMatch[1]) : 502,
          'upstream_failed',
          String(error && error.message || error)
        );
        err.cause = error;
        if (error && error.upstreamUrl) err.upstreamUrl = String(error.upstreamUrl);
        throw err;
      }

      const candidates = extractGeminiCandidates(envelope);
      const partsOut = (candidates && candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
      const images = partsOut
        .map((part) => {
          const inline = readInlineData(part);
          if (!inline) return null;
          return { b64_json: inline.data, mimeType: inline.mimeType };
        })
        .filter(Boolean);
      if (images.length === 0) {
        throw new ImageGenerationError(502, 'upstream_failed', 'gemini returned no image output');
      }

      const usageCapture = createModelUsageCapture();
      usageCapture.observePayload(envelope);
      const usageInput = usageCapture.getUsageInput();

      return { images, usageInput, raw: envelope };
    }
  };
}

module.exports = {
  createAgyGeminiImageGenerationStrategy,
  __private: {
    DEFAULT_TIMEOUT_MS
  }
};
