'use strict';

// Strategy-pattern contract for the OpenAI-compatible image generation
// endpoints (POST /v1/images/generations and POST /v1/images/edits).
//
// Each strategy owns one upstream provider family's wire translation:
//   - image-generation-agy-gemini.js   -> agy/gemini Code Assist generateContent
//   - image-generation-codex.js        -> codex OAuth dedicated Images API
//   - image-generation-passthrough.js  -> any api-key OpenAI-compatible upstream
//   - image-generation-unsupported.js  -> explicit 400 for providers without images
//
// The facade (image-generations-endpoint.js) resolves the provider and account,
// picks a strategy from the registry, and renders the OpenAI response shape —
// strategies never touch the HTTP response, keeping orchestration and wire
// translation in separate layers (single-responsibility).

/**
 * @typedef {Object} ImageGenerationStrategy
 * @property {string} provider - canonical provider key the strategy serves
 * @property {'native'|'passthrough'|'unsupported'} kind - capability family
 * @property {{generation?: boolean, edit?: boolean, mask?: boolean, multiple?: boolean,
 *   size?: boolean, quality?: boolean, responseFormat?: boolean, maxInputImages?: number,
 *   background?: boolean, outputFormat?: boolean, outputCompression?: boolean,
 *   moderation?: boolean}} [capabilities] -
 *   request semantics supported by this strategy.
 * @property {(modelId: string, deps?: object) => boolean} supportsModel -
 *   capability gate: whether this strategy can generate images for the model.
 *   Passthrough always returns true (upstream is the authority); unsupported
 *   always returns false.
 * @property {(input: object) => Promise<ImageGenerationStrategyResult>} generate -
 *   Executes one image generation/edit against the upstream provider.
 */

/**
 * @typedef {Object} ImageGenerationStrategyResult
 * @property {Array<{b64_json?: string, url?: string, mimeType?: string, revised_prompt?: string}>} images
 * @property {{usage: object, usageFormat: string, model: string}|null} [usageInput]
 * @property {object} [raw] - raw upstream body, retained for diagnostics
 */

// Typed error carrying the HTTP status and machine-readable code the facade
// maps onto the OpenAI error envelope: { error: { message, type, code } }.
class ImageGenerationError extends Error {
  constructor(statusCode, code, detail) {
    super(String(detail || code || 'image_generation_failed'));
    this.name = 'ImageGenerationError';
    this.statusCode = Number(statusCode) || 502;
    this.code = String(code || 'upstream_failed').trim();
    this.detail = String(detail || this.message);
  }
}

module.exports = {
  ImageGenerationError
};
