'use strict';

const { readKimiOAuthCredentials } = require('../kimi-auth');
const { buildKimiIdentitySeed } = require('../subject-oauth-identity');

module.exports = Object.freeze({
  id: 'kimi',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => readKimiOAuthCredentials(source),
  nativeIdentitySeed: (auth) => buildKimiIdentitySeed(auth)
});
