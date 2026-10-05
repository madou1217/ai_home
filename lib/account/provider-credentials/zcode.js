'use strict';

const { buildZcodeIdentitySeed } = require('../subject-oauth-identity');

module.exports = Object.freeze({
  id: 'zcode',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.credentials || null,
  nativeIdentitySeed: (auth) => buildZcodeIdentitySeed(auth)
});
