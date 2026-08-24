'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseImageGenerationRequest,
  parseImageDataUrl
} = require('../lib/server/image-generation-request');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

function parseWithError(body, pathname) {
  try {
    parseImageGenerationRequest(body, pathname);
  } catch (error) {
    assert.ok(error instanceof ImageGenerationError, 'expected ImageGenerationError');
    return error;
  }
  assert.fail('expected parse to throw');
}

test('parseImageGenerationRequest accepts a minimal generations request', () => {
  const out = parseImageGenerationRequest({ model: 'gpt-image-1', prompt: 'a cat' }, '/v1/images/generations');
  assert.equal(out.mode, 'generation');
  assert.equal(out.model, 'gpt-image-1');
  assert.equal(out.prompt, 'a cat');
  assert.equal(out.n, 1);
  assert.equal(out.responseFormat, 'b64_json');
  assert.equal('image' in out, false);
});

test('parseImageGenerationRequest normalizes the optional provider routing hint', () => {
  const out = parseImageGenerationRequest({
    provider: ' Codex ',
    model: 'gpt-image-2',
    prompt: 'a cat'
  }, '/v1/images/generations');
  assert.equal(out.provider, 'codex');
});

test('parseImageGenerationRequest treats edits pathname as edit mode', () => {
  const body = {
    model: 'gpt-image-1',
    prompt: 'add a hat',
    image: PNG_DATA_URL
  };
  const out = parseImageGenerationRequest(body, '/v1/images/edits');
  assert.equal(out.mode, 'edit');
  assert.equal(out.images.length, 1);
  assert.deepEqual(out.images[0], { mimeType: 'image/png', data: out.images[0].data });
  assert.match(out.images[0].data, /^[A-Za-z0-9+/=]+$/);
  assert.equal('image' in out, false);
});

test('parseImageGenerationRequest preserves ordered edit references and image output controls', () => {
  const out = parseImageGenerationRequest({
    model: 'gpt-image-2',
    prompt: 'combine both references',
    images: [
      { image_url: PNG_DATA_URL },
      { image_url: JPEG_DATA_URL }
    ],
    background: 'TRANSPARENT',
    output_format: 'WEBP',
    output_compression: 73,
    moderation: 'LOW'
  }, '/v1/images/edits');

  assert.deepEqual(out.images.map((image) => image.mimeType), ['image/png', 'image/jpeg']);
  assert.equal(out.background, 'transparent');
  assert.equal(out.outputFormat, 'webp');
  assert.equal(out.outputCompression, 73);
  assert.equal(out.moderation, 'low');
});

test('parseImageGenerationRequest rejects ambiguous singular and plural edit inputs', () => {
  const error = parseWithError({
    model: 'm',
    prompt: 'p',
    image: PNG_DATA_URL,
    images: [{ image_url: JPEG_DATA_URL }]
  }, '/v1/images/edits');
  assert.equal(error.code, 'ambiguous_image_input');
});

test('parseImageGenerationRequest requires model and prompt', () => {
  assert.equal(parseWithError({ prompt: 'x' }, '/v1/images/generations').code, 'model_required');
  assert.equal(parseWithError({ model: 'gpt-image-1' }, '/v1/images/generations').code, 'prompt_required');
});

test('parseImageGenerationRequest validates n bounds', () => {
  assert.equal(parseWithError({ model: 'm', prompt: 'p', n: 0 }, '/v1/images/generations').code, 'invalid_n');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', n: 11 }, '/v1/images/generations').code, 'invalid_n');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', n: 1.5 }, '/v1/images/generations').code, 'invalid_n');
  const out = parseImageGenerationRequest({ model: 'm', prompt: 'p', n: 4 }, '/v1/images/generations');
  assert.equal(out.n, 4);
});

test('parseImageGenerationRequest validates size and quality', () => {
  assert.equal(parseWithError({ model: 'm', prompt: 'p', size: 'square' }, '/v1/images/generations').code, 'invalid_size');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', quality: 'ultra' }, '/v1/images/generations').code, 'invalid_quality');
  const out = parseImageGenerationRequest({ model: 'm', prompt: 'p', size: '1792x1024', quality: 'HIGH' }, '/v1/images/generations');
  assert.equal(out.size, '1792x1024');
  assert.equal(out.quality, 'high');
});

test('parseImageGenerationRequest validates response_format', () => {
  assert.equal(parseWithError({ model: 'm', prompt: 'p', response_format: 'xml' }, '/v1/images/generations').code, 'invalid_response_format');
  assert.equal(parseImageGenerationRequest({ model: 'm', prompt: 'p', response_format: 'url' }, '/v1/images/generations').responseFormat, 'url');
  assert.equal(parseImageGenerationRequest({ model: 'm', prompt: 'p', response_format: 'b64_json' }, '/v1/images/generations').responseFormat, 'b64_json');
});

test('parseImageGenerationRequest requires a valid image for edits', () => {
  assert.equal(parseWithError({ model: 'm', prompt: 'p' }, '/v1/images/edits').code, 'image_required');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'not-a-data-url' }, '/v1/images/edits').code, 'invalid_image_data_url');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'data:image/svg+xml;base64,PHN2Zz4=' }, '/v1/images/edits').code, 'invalid_image_mime');
  // empty or whitespace-only payloads never match the base64 data-url grammar
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'data:image/png;base64,' }, '/v1/images/edits').code, 'invalid_image_data_url');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'data:image/png;base64,   ' }, '/v1/images/edits').code, 'invalid_image_data_url');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'data:image/png;base64,====' }, '/v1/images/edits').code, 'invalid_image_data_url');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'data:image/png;base64,Zh==' }, '/v1/images/edits').code, 'invalid_image_data_url');
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: 'data:image/png;base64,aGVsbG8=' }, '/v1/images/edits').code, 'invalid_image_data_url');
  assert.equal(parseWithError({
    model: 'm',
    prompt: 'p',
    image: PNG_DATA_URL.replace('image/png', 'image/jpeg')
  }, '/v1/images/edits').code, 'invalid_image_mime');
});

test('parseImageGenerationRequest accepts a mask alongside the edit image', () => {
  const body = { model: 'm', prompt: 'p', image: PNG_DATA_URL, mask: PNG_DATA_URL };
  const out = parseImageGenerationRequest(body, '/v1/images/edits');
  assert.equal(out.mask.mimeType, 'image/png');
});

test('parseImageGenerationRequest requires PNG masks to preserve edit semantics', () => {
  const error = parseWithError({
    model: 'm',
    prompt: 'p',
    image: PNG_DATA_URL,
    mask: JPEG_DATA_URL
  }, '/v1/images/edits');
  assert.equal(error.code, 'invalid_image_mask_mime');
});

test('parseImageGenerationRequest rejects edit inputs on the generations endpoint', () => {
  assert.equal(parseWithError({
    model: 'm',
    prompt: 'p',
    image: PNG_DATA_URL
  }, '/v1/images/generations').code, 'image_requires_edit');
  assert.equal(parseWithError({
    model: 'm',
    prompt: 'p',
    images: [PNG_DATA_URL]
  }, '/v1/images/generations').code, 'image_requires_edit');
  assert.equal(parseWithError({
    model: 'm',
    prompt: 'p',
    mask: PNG_DATA_URL
  }, '/v1/images/generations').code, 'mask_requires_edit');
});

test('parseImageGenerationRequest limits edit references to sixteen images', () => {
  const error = parseWithError({
    model: 'm',
    prompt: 'p',
    images: Array.from({ length: 17 }, () => PNG_DATA_URL)
  }, '/v1/images/edits');
  assert.equal(error.code, 'invalid_image_count');
});

test('parseImageGenerationRequest validates image output controls without silently changing semantics', () => {
  assert.equal(parseWithError({
    model: 'm', prompt: 'p', background: 'clear'
  }, '/v1/images/generations').code, 'invalid_background');
  assert.equal(parseWithError({
    model: 'm', prompt: 'p', output_format: 'gif'
  }, '/v1/images/generations').code, 'invalid_output_format');
  assert.equal(parseWithError({
    model: 'm', prompt: 'p', output_format: 'jpeg', output_compression: 101
  }, '/v1/images/generations').code, 'invalid_output_compression');
  assert.equal(parseWithError({
    model: 'm', prompt: 'p', output_format: 'png', output_compression: 80
  }, '/v1/images/generations').code, 'output_compression_requires_lossy_format');
  assert.equal(parseWithError({
    model: 'm', prompt: 'p', background: 'transparent', output_format: 'jpeg'
  }, '/v1/images/generations').code, 'transparent_background_requires_alpha_format');
  assert.equal(parseWithError({
    model: 'm', prompt: 'p', moderation: 'strict'
  }, '/v1/images/generations').code, 'invalid_moderation');
});

test('parseImageGenerationRequest rejects oversized edit images', () => {
  // 6M base64 chars decode to ~4.5 MiB, safely above the 4 MiB cap
  const hugeBase64 = 'A'.repeat(6000000);
  const error = parseWithError(
    { model: 'm', prompt: 'p', image: `data:image/png;base64,${hugeBase64}` },
    '/v1/images/edits'
  );
  assert.equal(error.code, 'image_too_large');
});

test('parseImageGenerationRequest can raise the image limit for trusted Studio assets', () => {
  const bytes = Buffer.alloc((4 * 1024 * 1024) + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
  assert.equal(parseWithError({ model: 'm', prompt: 'p', image: dataUrl }, '/v1/images/edits').code, 'image_too_large');
  const out = parseImageGenerationRequest(
    { model: 'm', prompt: 'p', image: dataUrl },
    '/v1/images/edits',
    { maxImageBytes: 5 * 1024 * 1024 }
  );
  assert.equal(out.images[0].data.length > 4 * 1024 * 1024, true);
});

test('parseImageDataUrl normalizes mime and strips whitespace', () => {
  const spaced = PNG_DATA_URL.replace('base64,', 'base64,  ').replace(/=$/, '=  ');
  const out = parseImageDataUrl(spaced);
  assert.equal(out.mimeType, 'image/png');
  assert.equal(out.data, PNG_DATA_URL.split(',')[1]);
});
