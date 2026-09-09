'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { getNativeImageCapabilities } = require('./image-generation-model-specs');
const {
  createImageApiTransport, buildUpstreamUrl, readUpstreamErrorBody, readImageApiUsage
} = require('./image-generation-api-transport');

// Passthrough strategy: any api-key (apiKeyMode) account whose upstream speaks
// the OpenAI wire protocol. The gateway forwards the normalized OpenAI request
// to `{baseUrl}/images/generations` (JSON) or `/images/edits` (multipart, via
// the global FormData). Inbound OpenAI multipart is parsed earlier by the v1
// router into the same canonical request shape, so this strategy only owns the
// outbound wire translation. Usage is captured best-effort from the upstream
// `usage` field when present.

function createPassthroughImageGenerationStrategy(deps = {}) {
  const transport = createImageApiTransport(deps);
  return {
    provider: 'passthrough',
    kind: 'passthrough',
    capabilities: getNativeImageCapabilities('passthrough'),
    // The upstream endpoint is the authority on which models it can serve.
    supportsModel() {
      return true;
    },
    async generate(input) {
      const {
        mode,
        model,
        prompt,
        n,
        size,
        quality,
        responseFormat,
        images: inputImages,
        mask,
        background,
        outputFormat,
        outputCompression,
        moderation
      } = input;
      const headers = {};

      const commonFields = { model, prompt, n };
      if (size) commonFields.size = size;
      if (quality) commonFields.quality = quality;
      commonFields.response_format = responseFormat || 'b64_json';
      if (background) commonFields.background = background;
      if (outputFormat) commonFields.output_format = outputFormat;
      if (outputCompression != null) commonFields.output_compression = outputCompression;
      if (moderation) commonFields.moderation = moderation;

      let body;
      if (mode === 'edit') {
        // Produce (never parse) multipart for the upstream edits endpoint.
        const form = new FormData();
        const inputs = Array.isArray(inputImages) ? inputImages : [];
        const imageField = inputs.length > 1 ? 'image[]' : 'image';
        inputs.forEach((image, index) => {
          form.append(
            imageField,
            new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }),
            `image-${index + 1}`
          );
        });
        if (mask) {
          form.append('mask', new Blob([Buffer.from(mask.data, 'base64')], { type: mask.mimeType }), 'mask.png');
        }
        Object.entries(commonFields).forEach(([key, value]) => {
          if (value != null) form.append(key, String(value));
        });
        body = form;
        // FormData sets its own multipart content-type with boundary.
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(commonFields);
      }

      const json = await transport(input, { headers, body });

      const images = Array.isArray(json.data)
        ? json.data.map((item) => ({
            ...(item && typeof item === 'object' ? item : {}),
            ...(item && item.b64_json ? { b64_json: String(item.b64_json) } : {}),
            ...(item && item.url ? { url: String(item.url) } : {})
          }))
        : [];
      if (images.length === 0) {
        throw new ImageGenerationError(502, 'upstream_failed', 'upstream returned no image data');
      }

      return { images, usageInput: readImageApiUsage(json, model), raw: json };
    }
  };
}

module.exports = {
  createPassthroughImageGenerationStrategy,
  __private: {
    buildUpstreamUrl,
    readUpstreamErrorBody
  }
};
