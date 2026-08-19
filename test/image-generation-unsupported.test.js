'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createUnsupportedImageGenerationStrategy
} = require('../lib/server/image-generation-unsupported');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

test('unsupported strategy rejects every model with 400 unsupported_image_provider', async () => {
  const strategy = createUnsupportedImageGenerationStrategy('claude');
  assert.equal(strategy.provider, 'claude');
  assert.equal(strategy.kind, 'unsupported');
  assert.equal(strategy.supportsModel('claude-sonnet-4-6'), false);
  assert.equal(strategy.supportsModel(''), false);

  await assert.rejects(
    strategy.generate({ model: 'claude-sonnet-4-6', prompt: 'x' }),
    (error) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'unsupported_image_provider');
      assert.match(error.message, /claude/);
      return true;
    }
  );
});