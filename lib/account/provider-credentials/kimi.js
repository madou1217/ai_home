'use strict';

const {
  hasUsableKimiOAuth,
  readKimiOAuthCredentials,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId
} = require('../kimi-auth');
const { buildKimiIdentitySeed } = require('../subject-oauth-identity');

module.exports = Object.freeze({
  id: 'kimi',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => readKimiOAuthCredentials(source),
  nativeIdentitySeed: (auth) => buildKimiIdentitySeed(auth),
  importAliases: ['moonshot', 'kimi-code', 'moonshot-ai'],
  transferIdentitySeed: (auth) => buildKimiIdentitySeed(auth.credentials || auth.auth || auth),
  importCredentialEnv: Object.freeze({ keys: ['MOONSHOT_API_KEY'], credentialType: 'api-key' }),
  exportRecord: (nativeAuth) => {
    const credentials = readKimiOAuthCredentials(nativeAuth);
    const deviceId = resolveKimiOAuthDeviceId(nativeAuth);
    const auth = { ...credentials, ...(deviceId ? { device_id: deviceId } : {}) };
    return {
      auth,
      meta: {
        userId: String(auth.user_id || '').trim(),
        deviceId: String(auth.device_id || '').trim(),
        expiresAt: readKimiTokenExpiry(credentials) || null
      }
    };
  },
  exportOAuthKind: (auth) => (hasUsableKimiOAuth(auth) ? 'oauth' : '')
});
