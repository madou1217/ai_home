'use strict';

const {
  hasUsableKimiOAuth,
  readKimiOAuthCredentials,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId
} = require('../kimi-auth');
const { firstNonEmptyString, isPlainObject, removeEmptyValues } = require('./transfer-fields');
const { apiKeyEnvFromFacts } = require('./import-env');

function normalizeKimiOAuthAuth(account) {
  const payload = isPlainObject(account) ? account : {};
  const credentials = readKimiOAuthCredentials(payload);
  const value = (...keys) => firstNonEmptyString(...keys.map((key) => credentials[key]));
  const numericOrString = (...keys) => {
    for (const key of keys) {
      const candidate = credentials[key];
      if (candidate === undefined || candidate === null || String(candidate).trim() === '') continue;
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric <= 0) continue;
      return candidate;
    }
    return undefined;
  };
  return removeEmptyValues({
    access_token: value('access_token', 'accessToken'),
    refresh_token: value('refresh_token', 'refreshToken'),
    expires_at: numericOrString('expires_at', 'expiresAt'),
    expires_in: numericOrString('expires_in', 'expiresIn'),
    scope: value('scope'),
    token_type: value('token_type', 'tokenType'),
    device_id: value('device_id', 'deviceId'),
    user_id: value('user_id', 'userId')
  });
}
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
  exportOAuthKind: (auth) => (hasUsableKimiOAuth(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => removeEmptyValues({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
    expires_at: auth.expires_at,
    expires_in: auth.expires_in,
    scope: auth.scope,
    token_type: auth.token_type,
    device_id: auth.device_id,
    user_id: auth.user_id
  }),
  importApiKeyEnv: (config) => apiKeyEnvFromFacts('kimi', config),
  // 原生布局把设备 id 放在 credentials 外层。
  importNativeAuth: (auth) => {
    const credentials = { ...(auth || {}) };
    const deviceId = firstNonEmptyString(credentials.device_id, credentials.deviceId);
    delete credentials.device_id;
    delete credentials.deviceId;
    return { credentials, ...(deviceId ? { deviceId } : {}) };
  },
  normalizeImportedOAuth: (account) => normalizeKimiOAuthAuth(account)
});
