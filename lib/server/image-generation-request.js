'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { decodeCanonicalBase64, detectImageMime, normalizeImageMime } = require('./image-data');

// Pure request parsing/validation for the OpenAI-compatible image endpoints.
// The facade delegates all input shaping here so wire concerns never leak into
// strategy dispatch (single-responsibility; trivially unit-testable).

const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB, matches chat image attachments
const MAX_IMAGE_INPUTS = 16;
const QUALITY_VALUES = new Set(['low', 'medium', 'high', 'auto']);
const BACKGROUND_VALUES = new Set(['auto', 'transparent', 'opaque']);
const OUTPUT_FORMAT_VALUES = new Set(['png', 'jpeg', 'webp']);
const MODERATION_VALUES = new Set(['auto', 'low']);
const SIZE_PATTERN = /^(auto|[0-9]{2,5}x[0-9]{2,5})$/;

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requestError(code, detail) {
  return new ImageGenerationError(400, code, detail);
}

function resolveMaxImageBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : MAX_IMAGE_BYTES;
}

function formatImageLimit(maxBytes) {
  return maxBytes % (1024 * 1024) === 0
    ? `${maxBytes / (1024 * 1024)} MiB`
    : `${maxBytes} byte`;
}

function parseOptionalEnum(value, allowed, code, detail) {
  if (value == null) return '';
  const normalized = toTrimmedString(value).toLowerCase();
  if (!allowed.has(normalized)) throw requestError(code, detail);
  return normalized;
}

function readImageReference(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.image_url === 'string') {
    return value.image_url;
  }
  throw requestError(
    'invalid_image_reference',
    'each image must be a data URL or an object with an image_url data URL'
  );
}

function parseEditImages(body, options) {
  const hasImage = body.image != null;
  const hasImages = body.images != null;
  if (hasImage && hasImages) {
    throw requestError('ambiguous_image_input', 'choose either image or images, not both');
  }
  const source = hasImages ? body.images : body.image;
  const values = Array.isArray(source) ? source : source == null ? [] : [source];
  if (values.length < 1) throw requestError('image_required', 'image is required for image edits');
  if (values.length > MAX_IMAGE_INPUTS) {
    throw requestError('invalid_image_count', `image edits support at most ${MAX_IMAGE_INPUTS} input images`);
  }
  return values.map((value) => parseImageDataUrl(readImageReference(value), {
    maxBytes: options && options.maxImageBytes
  }));
}

// Parse a `data:<mime>;base64,<payload>` image. Returns { mimeType, data } where
// data is the base64 body without the prefix — the shape strategies need.
function parseImageDataUrl(dataUrl, options = {}) {
  const text = toTrimmedString(dataUrl);
  const match = text.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) throw requestError('invalid_image_data_url', 'image must be a data URL with base64 payload');
  const mimeType = normalizeImageMime(match[1]);
  if (!IMAGE_MIME_WHITELIST.has(mimeType)) {
    throw requestError('invalid_image_mime', `unsupported image mime type: ${String(match[1] || '').trim().toLowerCase()}`);
  }
  const decoded = decodeCanonicalBase64(match[2]);
  if (!decoded) {
    throw requestError('invalid_image_data_url', 'image base64 payload is empty or invalid');
  }
  const maxBytes = resolveMaxImageBytes(options && options.maxBytes);
  if (decoded.bytes.length > maxBytes) {
    throw requestError('image_too_large', `image exceeds ${formatImageLimit(maxBytes)} limit`);
  }
  const detectedMimeType = detectImageMime(decoded.bytes);
  if (!detectedMimeType) {
    throw requestError('invalid_image_data_url', 'image base64 payload is not a supported image');
  }
  if (detectedMimeType !== mimeType) {
    throw requestError('invalid_image_mime', `declared image mime type ${mimeType} does not match ${detectedMimeType} bytes`);
  }
  return { mimeType, data: decoded.base64 };
}

/**
 * Validate and normalize one /v1/images/* request body.
 * @param {object} requestJson
 * @param {string} pathname - '/v1/images/generations' | '/v1/images/edits'
 * @param {{maxImageBytes?: number, maxMaskBytes?: number}} [options] - trusted
 *   callers may raise one field's byte limit without widening public uploads.
 * @returns {{mode: 'generation'|'edit', provider?: string, model: string, prompt: string, n: number,
 *   size?: string, quality?: string, responseFormat: 'url'|'b64_json',
 *   images?: Array<{mimeType: string, data: string}>, mask?: {mimeType: string, data: string},
 *   background?: string, outputFormat?: string, outputCompression?: number, moderation?: string}}
 */
function parseImageGenerationRequest(requestJson, pathname, options = {}) {
  const body = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const mode = pathname === '/v1/images/edits' ? 'edit' : 'generation';

  const model = toTrimmedString(body.model);
  if (!model) throw requestError('model_required', 'model is required');

  const provider = toTrimmedString(body.provider).toLowerCase();

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

  const background = parseOptionalEnum(
    body.background,
    BACKGROUND_VALUES,
    'invalid_background',
    'background must be one of auto, transparent, opaque'
  );
  const outputFormat = parseOptionalEnum(
    body.output_format,
    OUTPUT_FORMAT_VALUES,
    'invalid_output_format',
    'output_format must be one of png, jpeg, webp'
  );
  const moderation = parseOptionalEnum(
    body.moderation,
    MODERATION_VALUES,
    'invalid_moderation',
    'moderation must be one of auto, low'
  );

  let outputCompression;
  if (body.output_compression != null) {
    outputCompression = Number(body.output_compression);
    if (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
      throw requestError('invalid_output_compression', 'output_compression must be an integer between 0 and 100');
    }
    if (outputFormat !== 'jpeg' && outputFormat !== 'webp') {
      throw requestError(
        'output_compression_requires_lossy_format',
        'output_compression requires output_format jpeg or webp'
      );
    }
  }
  if (background === 'transparent' && outputFormat === 'jpeg') {
    throw requestError(
      'transparent_background_requires_alpha_format',
      'transparent backgrounds require output_format png or webp'
    );
  }

  let images;
  if (mode === 'edit') {
    images = parseEditImages(body, options);
  } else if (body.image != null || body.images != null) {
    throw requestError('image_requires_edit', 'image input requires the image edits endpoint');
  }

  let mask;
  if (body.mask != null) {
    if (mode !== 'edit') throw requestError('mask_requires_edit', 'image masks require the image edits endpoint');
    mask = parseImageDataUrl(body.mask, { maxBytes: options && options.maxMaskBytes });
    if (mask.mimeType !== 'image/png') {
      throw requestError('invalid_image_mask_mime', 'image masks must use image/png');
    }
  }

  return {
    mode,
    ...(provider ? { provider } : {}),
    model,
    prompt,
    n,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    responseFormat,
    ...(images ? { images } : {}),
    ...(background ? { background } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(outputCompression != null ? { outputCompression } : {}),
    ...(moderation ? { moderation } : {}),
    ...(mask ? { mask } : {})
  };
}

module.exports = {
  parseImageGenerationRequest,
  parseImageDataUrl,
  __private: {
    IMAGE_MIME_WHITELIST,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_INPUTS,
    BACKGROUND_VALUES,
    MODERATION_VALUES,
    OUTPUT_FORMAT_VALUES,
    formatImageLimit,
    parseEditImages,
    parseOptionalEnum,
    readImageReference,
    resolveMaxImageBytes
  }
};
