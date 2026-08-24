'use strict';

const { decodeCanonicalBase64, detectImageMime, normalizeImageMime } = require('./image-data');
const { ImageGenerationError } = require('./image-generation-strategy');

function normalizeImageOutputUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_error) {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  return url.toString();
}

function revisedPromptFields(item) {
  return item && typeof item.revised_prompt === 'string'
    ? { revised_prompt: item.revised_prompt }
    : {};
}

function normalizeBase64Image(item) {
  const decoded = decodeCanonicalBase64(item && item.b64_json);
  if (!decoded) {
    throw new ImageGenerationError(502, 'invalid_image_output', 'upstream returned invalid image base64');
  }
  const detectedMimeType = detectImageMime(decoded.bytes);
  if (!detectedMimeType) {
    throw new ImageGenerationError(502, 'invalid_image_output', 'upstream returned base64 that is not a supported image');
  }
  const declaredMimeType = normalizeImageMime(item && item.mimeType);
  if (item && item.mimeType && (!declaredMimeType || declaredMimeType !== detectedMimeType)) {
    throw new ImageGenerationError(502, 'invalid_image_output', 'upstream image mime type does not match its bytes');
  }
  return {
    b64_json: decoded.base64,
    mimeType: detectedMimeType,
    ...revisedPromptFields(item)
  };
}

function normalizeImageGenerationImages(images) {
  const normalized = [];
  for (const item of Array.isArray(images) ? images : []) {
    if (!item || typeof item !== 'object') continue;
    if (String(item.b64_json || '').trim()) {
      normalized.push(normalizeBase64Image(item));
      continue;
    }
    if (String(item.url || '').trim()) {
      const url = normalizeImageOutputUrl(item.url);
      if (!url) {
        throw new ImageGenerationError(502, 'invalid_image_output_url', 'upstream returned an unsafe or malformed image URL');
      }
      normalized.push({ url, ...revisedPromptFields(item) });
    }
  }
  if (normalized.length < 1) {
    throw new ImageGenerationError(502, 'image_output_missing', 'upstream returned no usable image data');
  }
  return normalized;
}

function normalizeImageGenerationResult(result) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    ...value,
    images: normalizeImageGenerationImages(value.images)
  };
}

module.exports = {
  normalizeImageGenerationImages,
  normalizeImageGenerationResult,
  __private: {
    normalizeBase64Image,
    normalizeImageOutputUrl,
    revisedPromptFields
  }
};
