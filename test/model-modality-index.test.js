const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getModelModalities,
  modelGeneratesImages,
  modelMatchesCapability,
  modelSupportsVision
} = require('../lib/server/model-modality-index');

test('glm-5.2 (bare and opencode-go prefixed) is text-only, no vision', () => {
  assert.deepEqual(getModelModalities('glm-5.2'), { input: ['text'], output: ['text'] });
  assert.equal(modelSupportsVision('glm-5.2'), false);
  assert.equal(modelGeneratesImages('glm-5.2'), false);

  assert.deepEqual(getModelModalities('opencode-go/glm-5.2'), { input: ['text'], output: ['text'] });
  assert.equal(modelSupportsVision('opencode-go/glm-5.2'), false);
  assert.equal(modelGeneratesImages('opencode-go/glm-5.2'), false);
});

test('claude-sonnet-4-6 supports vision via models.dev metadata', () => {
  const modalities = getModelModalities('claude-sonnet-4-6');
  assert.equal(modalities.input.includes('image'), true);
  assert.equal(modalities.output.includes('image'), false);
  assert.equal(modelSupportsVision('claude-sonnet-4-6'), true);
  assert.equal(modelGeneratesImages('claude-sonnet-4-6'), false);
});

test('gemini-3.1-flash-image and gpt-image-2 generate images', () => {
  assert.equal(modelGeneratesImages('gemini-3.1-flash-image'), true);
  assert.equal(getModelModalities('gemini-3.1-flash-image').output.includes('image'), true);

  assert.equal(modelGeneratesImages('gpt-image-2'), true);
  assert.equal(getModelModalities('gpt-image-2').output.includes('image'), true);
});

test('gemini-3-flash has vision input but does not generate images', () => {
  assert.equal(modelSupportsVision('gemini-3-flash'), true);
  assert.equal(modelGeneratesImages('gemini-3-flash'), false);
});

test('unknown model falls back to text-only modalities', () => {
  assert.deepEqual(getModelModalities('totally-unknown-model'), { input: ['text'], output: ['text'] });
  assert.equal(modelSupportsVision('totally-unknown-model'), false);
  assert.equal(modelGeneratesImages('totally-unknown-model'), false);
});

test('empty model id defaults to text-only without caching', () => {
  assert.deepEqual(getModelModalities(''), { input: ['text'], output: ['text'] });
  assert.deepEqual(getModelModalities(null), { input: ['text'], output: ['text'] });
});

test('returned modality arrays are copies, cache stays immutable', () => {
  const first = getModelModalities('claude-sonnet-4-6');
  first.input.length = 0;
  first.output.push('mutated');
  const second = getModelModalities('claude-sonnet-4-6');
  assert.equal(second.input.includes('image'), true);
  assert.equal(second.output.includes('mutated'), false);
});

test('modelMatchesCapability maps vision/image_out and fails open on unknown capability', () => {
  assert.equal(modelMatchesCapability('claude-sonnet-4-6', 'vision'), true);
  assert.equal(modelMatchesCapability('glm-5.2', 'vision'), false);
  assert.equal(modelMatchesCapability('gpt-image-2', 'image_out'), true);
  assert.equal(modelMatchesCapability('gemini-3-flash', 'image_out'), false);
  assert.equal(modelMatchesCapability('glm-5.2', ''), true);
  assert.equal(modelMatchesCapability('glm-5.2', 'not-a-capability'), true);
});
