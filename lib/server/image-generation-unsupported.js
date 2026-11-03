'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');

// Explicit 400 strategy for providers that can never serve image generation
// (e.g. claude). Kept as a strategy so the facade has a uniform dispatch path
// — a provider without a native strategy still flows through the registry
// instead of sprouting bespoke error branches in the orchestration layer.

function createUnsupportedImageGenerationStrategy(provider) {
  const providerName = String(provider || '').trim().toLowerCase() || 'unknown';
  return {
    provider: providerName,
    kind: 'unsupported',
    supportsModel() {
      return false;
    },
    async generate() {
      throw new ImageGenerationError(
        400,
        'unsupported_image_provider',
        `provider ${providerName} has no image generation support`
      );
    }
  };
}

module.exports = {
  createUnsupportedImageGenerationStrategy
};
