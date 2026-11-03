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
 * @property {'native'|'passthrough'|'adapter'|'unsupported'} kind - capability family
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

// statusCode 是给客户端看的状态，**不是**上游状态码。没有新的上游 HTTP 答复的失败
// （读正文超时 / socket 断开 / 200 但没出图）必须带一个 cause：执行器见到 cause 就按
// 状态码 0 交给失败策略的超时 / 网络 / 空产出判定，而不是把伪造的 502 读成「上游 5xx」
// 去冷却 (账号, 模型)。cause 的 code 决定分类（ETIMEDOUT → timeout，
// EMPTY_UPSTREAM_RESPONSE → empty_model_response，undici 的 socket code → network_error）。
function withFailureCause(error, cause) {
  error.cause = cause;
  return error;
}

function createImageOutputMissingError(detail) {
  const message = String(detail || 'upstream returned no image data');
  return withFailureCause(
    new ImageGenerationError(502, 'upstream_failed', message),
    Object.assign(new Error(message), { code: 'EMPTY_UPSTREAM_RESPONSE' })
  );
}

module.exports = {
  ImageGenerationError,
  createImageOutputMissingError,
  withFailureCause
};
