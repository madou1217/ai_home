'use strict';

const { buildZcodeIdentitySeed } = require('../subject-oauth-identity');
const { decryptZcodeCredentialRecord, encryptZcodeCredentialValue } = require('../zcode-credential');
const { materializeZcodeNativeAuth } = require('../go-bridge/zcode-native-auth');
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
  importAliases: [],
  transferIdentitySeed: (auth) => buildZcodeIdentitySeed(auth.credentials || auth),
  importCredentialEnv: Object.freeze({ keys: ['ZCODE_API_KEY'], credentialType: 'api-key', baseUrlKeys: ['ZCODE_BASE_URL'] }),
  importApiKeyEnv: (config) => apiKeyEnvFromFacts('zcode', config),
  // 原生凭据的值用本机派生的密钥加密，换一台机器就解不开：导出解密成明文，导入时用目标机的密钥重新加密。
  exportRecord: (nativeAuth) => {
    const materialized = materializeZcodeNativeAuth(nativeAuth);
    const auth = materialized ? materialized.credentials : {};
    return { auth, meta: {} };
  },
  exportOAuthKind: (auth) => (hasOAuthSecret(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => ({ ...auth }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.auth)
      ? account.auth
      : (isPlainObject(account && account.credentials) ? account.credentials : account);
    if (!isPlainObject(candidate)) return null;
    const plain = decryptZcodeCredentialRecord(candidate);
    return hasOAuthSecret(plain) ? plain : null;
  },
  importNativeAuth: (auth) => ({
    credentials: Object.fromEntries(Object.entries(auth || {}).map(([key, value]) => [
      key,
      typeof value === 'string' ? encryptZcodeCredentialValue(value) : value
    ]))
  })
});
