'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { isImageGenerationModel, __private: { readInlineData } } = require('./code-assist-image-generation');
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

function createAgyGeminiImageGenerationStrategy(deps = {}) {
  const fetchGeminiCodeAssistGenerateContent = deps.fetchGeminiCodeAssistGenerateContent;
  return {
    provider: 'agy',
    kind: 'native',
    supportsModel(modelId) {
      return isImageGenerationModel(modelId);
    },
    async generate(input) {
      if (typeof fetchGeminiCodeAssistGenerateContent !== 'function') {
        throw new ImageGenerationError(500, 'agy_transport_unavailable', 'agy gemini transport is not configured');
      }
      const { mode, model, prompt, image, account, options } = input;
      const parts = [{ text: prompt }];
      if (mode === 'edit') {
        if (!image) throw new ImageGenerationError(400, 'image_required', 'image is required for image edits');
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
      }
      const requestJson = {
        model,
        contents: [{ role: 'user', parts }],
        // IMAGE modality is mandatory; undefined thinkingConfig removes the
        // default thinking budget so the model draws instead of narrating.
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          thinkingConfig: undefined
        }
      };
      const timeoutMs = Number(options && options.upstreamTimeoutMs) || DEFAULT_TIMEOUT_MS;

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
        throw new ImageGenerationError(502, 'upstream_failed', String(error && error.message || error));
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
