'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { IMAGE_API_PROFILES } = require('./image-generation-api-profiles');
const { createImageApiTransport, readImageApiUsage } = require('./image-generation-api-transport');

function resolveDimensions(size) {
  const value = !size || size === 'auto' ? '1024x1024' : size;
  const match = /^(\d+)x(\d+)$/.exec(value);
  const width = match && Number(match[1]);
  const height = match && Number(match[2]);
  if (!match || width < 64 || width > 4096 || height < 64 || height > 4096) {
    throw new ImageGenerationError(400, 'unsupported_image_size', 'llm-api image dimensions must be 64 to 4096 pixels');
  }
  return { width, height };
}

function imageReference(image) {
  return { image_url: `data:${image.mimeType};base64,${image.data}` };
}

// llm-api's dedicated Images contract uses JSON for both operations, explicit
// purpose/dimensions/metadata and a root b64_json response (not OpenAI data[]).
function createLlmApiImageGenerationStrategy(deps = {}) {
  const transport = createImageApiTransport(deps);
  const profile = IMAGE_API_PROFILES['llm-api'];
  const supportsModel = (model) => profile.models.some((spec) => spec.id === String(model || '').trim().toLowerCase());
  return {
    provider: 'llm-api',
    kind: 'adapter',
    capabilities: profile.capabilities,
    supportsModel,
    async generate(input) {
      if (!supportsModel(input.model)) {
        throw new ImageGenerationError(400, 'unsupported_model_for_images', 'llm-api images require gpt-image-2');
      }
      const body = {
        model: 'gpt-image-2',
        prompt: input.prompt,
        purpose: input.mode === 'edit' ? 'Edit an image for the API client' : 'Generate an image for the API client',
        ...resolveDimensions(input.size),
        output_format: input.outputFormat || 'png',
        metadata: {}
      };
      if (input.mode === 'edit') {
        body.images = (input.images || []).map(imageReference);
        // OpenAI masks apply to the first input. llm-api requires its image id
        // when there are multiple inputs and assigns image_1 by default.
        if (input.mask) body.mask = { ...imageReference(input.mask), input_image_id: 'image_1' };
      }
      // Match the upstream's ten-minute generation deadline; a short transport
      // timeout can abandon a billable image while it is still being generated.
      const json = await transport(input, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }, 600000);
      if (json.status !== 'succeeded' || typeof json.b64_json !== 'string' || !json.b64_json.trim()) {
        throw new ImageGenerationError(502, 'upstream_failed', 'llm-api returned no successful image result');
      }
      return {
        images: [{ b64_json: json.b64_json, ...(json.mime_type ? { mimeType: json.mime_type } : {}) }],
        usageInput: readImageApiUsage(json, input.model),
        raw: json
      };
    }
  };
}

module.exports = { createLlmApiImageGenerationStrategy };
