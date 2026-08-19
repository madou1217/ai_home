'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');

// Pure request parsing/validation for the OpenAI-compatible image endpoints.
// The facade delegates all input shaping here so wire concerns never leak into
// strategy dispatch (single-responsibility; trivially unit-testable).

const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB, matches chat image attachments
const QUALITY_VALUES = new Set(['low', 'medium', 'high', 'auto']);
const SIZE_PATTERN = /^(auto|[0-9]{2,5}x[0-9]{2,5})$/;

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requestError(code, detail) {
  return new ImageGenerationError(400, code, detail);
}

// Parse a `data:<mime>;base64,<payload>` image. Returns { mimeType, data } where
// data is the base64 body without the prefix — the shape strategies need.
function parseImageDataUrl(dataUrl) {
  const text = toTrimmedString(dataUrl);
  const match = text.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw requestError('invalid_image_data_url', 'image must be a data URL with base64 payload');
  const mimeType = match[1].trim().toLowerCase();
  if (!IMAGE_MIME_WHITELIST.has(mimeType)) {
    throw requestError('invalid_image_mime', `unsupported image mime type: ${mimeType}`);
  }
  const data = match[2].replace(/\s+/g, '');
  if (Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) {
    throw requestError('image_too_large', 'image exceeds 4 MiB limit');
  }
  return { mimeType, data };
}

/**
 * Validate and normalize one /v1/images/* request body.
 * @param {object} requestJson
 * @param {string} pathname - '/v1/images/generations' | '/v1/images/edits'
 * @returns {{mode: 'generation'|'edit', model: string, prompt: string, n: number,
 *   size?: string, quality?: string, responseFormat: 'url'|'b64_json',
 *   image?: {mimeType: string, data: string}, mask?: {mimeType: string, data: string}}}
 */
function parseImageGenerationRequest(requestJson, pathname) {
  const body = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const mode = pathname === '/v1/images/edits' ? 'edit' : 'generation';

  const model = toTrimmedString(body.model);
  if (!model) throw requestError('model_required', 'model is required');

  const prompt = toTrimmedString(body.prompt);
  if (!prompt) throw requestError('prompt_required', 'prompt is required');

  let n = 1;
  if (body.n != null) {
    n = Number(body.n);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw requestError('invalid_n', 'n must be an integer between 1 and 10');
    }
  }

  let size;
  if (body.size != null) {
    size = toTrimmedString(body.size);
    if (!SIZE_PATTERN.test(size)) {
      throw requestError('invalid_size', 'size must look like 1024x1024 or auto');
    }
  }

  let quality;
  if (body.quality != null) {
    quality = toTrimmedString(body.quality).toLowerCase();
    if (!QUALITY_VALUES.has(quality)) {
      throw requestError('invalid_quality', 'quality must be one of low, medium, high, auto');
    }
  }

  const responseFormatRaw = toTrimmedString(body.response_format).toLowerCase();
  const responseFormat = responseFormatRaw === 'url' ? 'url' : 'b64_json';
  if (responseFormatRaw && responseFormatRaw !== 'url' && responseFormatRaw !== 'b64_json') {
    throw requestError('invalid_response_format', 'response_format must be url or b64_json');
  }

  let image;
  if (mode === 'edit') {
    if (body.image == null) throw requestError('image_required', 'image is required for image edits');
    image = parseImageDataUrl(body.image);
  }

  let mask;
  if (body.mask != null) {
    mask = parseImageDataUrl(body.mask);
  }

  return {
    mode,
    model,
    prompt,
    n,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    responseFormat,
    ...(image ? { image } : {}),
    ...(mask ? { mask } : {})
  };
}

module.exports = {
  parseImageGenerationRequest,
  parseImageDataUrl,
  __private: {
    IMAGE_MIME_WHITELIST,
    MAX_IMAGE_BYTES
  }
};
