'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseImageGenerationRequest,
  parseImageDataUrl
} = require('../lib/server/image-generation-request');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

test('parseImageGenerationRequest treats edits pathname as edit mode', () => {
  const body = {
    model: 'gpt-image-1',
    prompt: 'add a hat',
    image: PNG_DATA_URL
  };
  const out = parseImageGenerationRequest(body, '/v1/images/edits');
  assert.equal(out.mode, 'edit');
  assert.deepEqual(out.image, { mimeType: 'image/png', data: out.image.data });
  assert.match(out.image.data, /^[A-Za-z0-9+/=]+$/);
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
});

test('parseImageGenerationRequest accepts a mask alongside the edit image', () => {
  const body = { model: 'm', prompt: 'p', image: PNG_DATA_URL, mask: PNG_DATA_URL };
  const out = parseImageGenerationRequest(body, '/v1/images/edits');
  assert.equal(out.mask.mimeType, 'image/png');
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

test('parseImageDataUrl normalizes mime and strips whitespace', () => {
  const spaced = `data:image/webp;base64,  aGVsbG8=  `;
  const out = parseImageDataUrl(spaced);
  assert.equal(out.mimeType, 'image/webp');
  assert.equal(out.data, 'aGVsbG8=');
});