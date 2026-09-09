'use strict';

const { resolveAccountImageApi } = require('./upstream-account-profile');
const { getNativeImageCapabilities } = require('./image-generation-model-specs');

// Explicit account endpoint contracts. Chat /models is not an image capability
// catalog for llm-api, so the declared dialect owns its dedicated image model.
const IMAGE_API_PROFILES = Object.freeze({
  openai: Object.freeze({
    strategyId: 'passthrough',
    models: Object.freeze([]),
    capabilities: Object.freeze(getNativeImageCapabilities('passthrough')),
    qualityOptions: Object.freeze(['low', 'medium', 'high'])
  }),
  'llm-api': Object.freeze({
    strategyId: 'llm-api',
    models: Object.freeze([
      Object.freeze({ id: 'gpt-image-2', label: 'GPT Image 2', priority: 10 })
    ]),
    capabilities: Object.freeze({
      generation: true,
      edit: true,
      mask: true,
      multiple: false,
      size: true,
      quality: false,
      responseFormat: true,
      maxInputImages: 16,
      background: false,
      outputFormat: true,
      outputCompression: false,
      moderation: false
    }),
    qualityOptions: Object.freeze([])
  })
});

function getAccountImageApiProfile(account) {
  const key = resolveAccountImageApi(account);
  return Object.hasOwn(IMAGE_API_PROFILES, key) ? IMAGE_API_PROFILES[key] : null;
}

module.exports = { IMAGE_API_PROFILES, getAccountImageApiProfile };
