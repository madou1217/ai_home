'use strict';

const { detectImageMime, normalizeImageMime } = require('./image-data');
const { ImageGenerationError } = require('./image-generation-strategy');
const { __private: { MAX_IMAGE_INPUTS } } = require('./image-generation-request');

const IMAGE_INPUT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SCALAR_FIELDS = Object.freeze([
  'model',
  'provider',
  'prompt',
  'n',
  'size',
  'quality',
  'response_format',
  'background',
  'output_format',
  'output_compression',
  'moderation'
]);

function multipartError(code, detail) {
  return new ImageGenerationError(400, code, detail);
}

function isImageMultipartContentType(value) {
  return /^multipart\/form-data(?:\s*;|\s*$)/i.test(String(value || '').trim());
}

function isFileValue(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.arrayBuffer === 'function'
    && typeof value.type === 'string'
  );
}

function collectValues(form, names) {
  return names.flatMap((name) => form.getAll(name));
}

function readScalarField(form, field) {
  const values = form.getAll(field);
  if (values.length > 1) {
    throw multipartError('duplicate_multipart_field', `multipart field ${field} must appear at most once`);
  }
  if (values.length === 0) return '';
  if (isFileValue(values[0])) {
    throw multipartError('invalid_multipart_field', `multipart field ${field} must be text`);
  }
  return String(values[0]);
}

async function fileToDataUrl(value, role) {
  if (!isFileValue(value)) {
    throw multipartError(
      role === 'mask' ? 'invalid_image_mask' : 'invalid_image_file',
      `${role} must be a multipart file`
    );
  }
  const bytes = Buffer.from(await value.arrayBuffer());
  const detectedMimeType = detectImageMime(bytes);
  const declaredMimeType = normalizeImageMime(value.type);
  const invalidMimeCode = role === 'mask' ? 'invalid_image_mask_mime' : 'invalid_image_mime';
  if (!detectedMimeType || !IMAGE_INPUT_MIME_TYPES.has(detectedMimeType)) {
    throw multipartError(invalidMimeCode, `${role} must be a PNG, JPEG, or WebP image`);
  }
  if (value.type && (!declaredMimeType || declaredMimeType !== detectedMimeType)) {
    throw multipartError(invalidMimeCode, `${role} mime type does not match its bytes`);
  }
  if (role === 'mask' && detectedMimeType !== 'image/png') {
    throw multipartError('invalid_image_mask_mime', 'image masks must use image/png');
  }
  return `data:${detectedMimeType};base64,${bytes.toString('base64')}`;
}

async function parseImageMultipartRequest(body, contentType) {
  if (!isImageMultipartContentType(contentType)) {
    throw multipartError('invalid_multipart_content_type', 'request content type must be multipart/form-data');
  }

  let form;
  try {
    form = await new Request('http://aih.local/v1/images/edits', {
      method: 'POST',
      headers: { 'content-type': String(contentType) },
      body: Buffer.isBuffer(body) ? body : Buffer.from(body || '')
    }).formData();
  } catch (_error) {
    throw multipartError('invalid_multipart_body', 'request body is not valid multipart/form-data');
  }

  const requestJson = {};
  SCALAR_FIELDS.forEach((field) => {
    const value = readScalarField(form, field);
    if (value !== '') requestJson[field] = value;
  });

  const images = collectValues(form, ['image', 'image[]']);
  if (images.length > MAX_IMAGE_INPUTS) {
    throw multipartError('invalid_image_count', `image edits support at most ${MAX_IMAGE_INPUTS} input images`);
  }
  if (images.length > 0) {
    requestJson.images = [];
    for (const image of images) {
      requestJson.images.push(await fileToDataUrl(image, 'image'));
    }
  }

  const masks = collectValues(form, ['mask', 'mask[]']);
  if (masks.length > 1) {
    throw multipartError('multiple_mask_inputs_unsupported', 'at most one image mask is supported');
  }
  if (masks.length === 1) requestJson.mask = await fileToDataUrl(masks[0], 'mask');

  return requestJson;
}

module.exports = {
  isImageMultipartContentType,
  parseImageMultipartRequest,
  __private: {
    IMAGE_INPUT_MIME_TYPES,
    SCALAR_FIELDS,
    collectValues,
    fileToDataUrl,
    isFileValue,
    readScalarField
  }
};
