'use strict';

const { buildGrokIdentitySeed } = require('../grok-identity');
const { isPlainObject } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'grok',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  nativeIdentitySeed: (auth) => buildGrokIdentitySeed(auth),
  importCredentialEnv: Object.freeze({ keys: ['XAI_API_KEY'], credentialType: 'api-key' }),
  sub2apiCredentials: (auth) => ({ ...auth }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
    return isPlainObject(candidate) && buildGrokIdentitySeed(candidate) ? candidate : null;
  }
});
