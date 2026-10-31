'use strict';

const { buildZcodeIdentitySeed } = require('../subject-oauth-identity');
const { decryptZcodeCredentialRecord } = require('../zcode-credential');
const { isPlainObject } = require('./transfer-fields');
const { apiKeyEnvFromFacts } = require('./import-env');

const OAUTH_SECRET_KEYS = Object.freeze(['zcodejwttoken', 'oauth:zai:access_token']);

function hasOAuthSecret(plain) {
  return OAUTH_SECRET_KEYS.some((key) => typeof plain[key] === 'string' && plain[key].trim());
}

module.exports = Object.freeze({
  id: 'zcode',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.credentials || null,
  nativeIdentitySeed: (auth) => buildZcodeIdentitySeed(auth),
  importCredentialEnv: Object.freeze({ keys: ['ZCODE_API_KEY'], credentialType: 'api-key', baseUrlKeys: ['ZCODE_BASE_URL'] }),
  importApiKeyEnv: (config) => apiKeyEnvFromFacts('zcode', config),
  sub2apiCredentials: (auth) => ({ ...auth }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.auth)
      ? account.auth
      : (isPlainObject(account && account.credentials) ? account.credentials : account);
    if (!isPlainObject(candidate)) return null;
    const plain = decryptZcodeCredentialRecord(candidate);
    return hasOAuthSecret(plain) ? plain : null;
  }
});
