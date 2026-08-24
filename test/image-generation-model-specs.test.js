'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getNativeImageCapabilities,
  imageModelBelongsToProvider,
  listNativeImageModelSpecs
} = require('../lib/server/image-generation-model-specs');

test('native image model specs advertise gpt-image-2 as the preferred Codex image intent', () => {
  const models = listNativeImageModelSpecs('codex');
  assert.deepEqual(models.map((item) => item.id), ['gpt-image-2']);
});

test('native Grok image specs include the current quality model', () => {
  const models = listNativeImageModelSpecs('grok');
  assert.deepEqual(models.map((item) => item.id), [
    'grok-imagine-image-2.0',
    'grok-imagine-image-quality',
    'grok-imagine-image'
  ]);
});

test('provider image model ownership rejects cross-provider image names', () => {
  assert.equal(imageModelBelongsToProvider('codex', 'gpt-image-2'), true);
  assert.equal(imageModelBelongsToProvider('codex', 'grok-imagine-image-2.0'), false);
  assert.equal(imageModelBelongsToProvider('agy', 'gemini-3.1-flash-image'), true);
  assert.equal(imageModelBelongsToProvider('gemini', 'nano-banana'), true);
  assert.equal(imageModelBelongsToProvider('grok', 'grok-imagine-image-2.0'), true);
  assert.equal(imageModelBelongsToProvider('grok', 'grok-imagine-image-quality'), true);
  assert.equal(imageModelBelongsToProvider('grok', 'grok-image-2'), true);
  assert.equal(imageModelBelongsToProvider('grok', 'gpt-image-2'), false);
});

test('native capability specs expose provider-specific controls', () => {
  assert.deepEqual(getNativeImageCapabilities('codex'), {
    generation: true,
    edit: true,
    mask: false,
    multiple: true,
    size: true,
    quality: true,
    responseFormat: true,
    maxInputImages: 5,
    background: true,
    outputFormat: false,
    outputCompression: false,
    moderation: false
  });
  assert.equal(getNativeImageCapabilities('agy', 'gemini-3.1-flash-image').maxInputImages, 14);
  assert.equal(getNativeImageCapabilities('agy', 'gemini-2.5-flash-image').maxInputImages, 1);
  assert.equal(getNativeImageCapabilities('grok', 'grok-imagine-image-2.0').maxInputImages, 3);
  assert.equal(getNativeImageCapabilities('grok', 'grok-imagine-image-quality').maxInputImages, 1);
  assert.equal(getNativeImageCapabilities('grok', 'grok-imagine-image').maxInputImages, 1);
  assert.equal(getNativeImageCapabilities('grok').quality, false);
  assert.equal(getNativeImageCapabilities('grok', 'grok-imagine-image-2.0').quality, true);
  assert.equal(getNativeImageCapabilities('grok', 'grok-imagine-image-quality').quality, false);
  assert.equal(getNativeImageCapabilities('grok', 'grok-imagine-image').quality, false);
  assert.equal(getNativeImageCapabilities('passthrough').maxInputImages, 16);
  assert.equal(getNativeImageCapabilities('claude'), null);
});
