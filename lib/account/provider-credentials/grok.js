'use strict';

const { buildGrokIdentitySeed } = require('../grok-identity');

module.exports = Object.freeze({
  id: 'grok',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  nativeIdentitySeed: (auth) => buildGrokIdentitySeed(auth),
  importAliases: ['xai'],
  transferIdentitySeed: (auth) => buildGrokIdentitySeed(auth.auth || auth),
  importCredentialEnv: Object.freeze({ keys: ['XAI_API_KEY'], credentialType: 'api-key' })
});
