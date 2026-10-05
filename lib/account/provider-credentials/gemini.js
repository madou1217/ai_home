'use strict';

const { emailIdentitySeed } = require('./email-identity');
const { parseJwtExpiryMs } = require('../codex-auth-metadata');
const {
  firstNonEmptyString,
  genericEmailCandidates,
  isPlainObject,
  objectOrEmpty,
  profileEmailCandidates,
  readNestedObject,
  removeEmptyValues
} = require('./transfer-fields');
const { transferEmail } = require('./email-identity');
const { apiKeyEnvFromFacts } = require('./import-env');

function normalizeGeminiOAuthAuth(account) {
  const payload = isPlainObject(account) ? account : {};
  const auth = readNestedObject(payload, 'auth');
  const credentials = readNestedObject(payload, 'credentials');
  const authCredentials = readNestedObject(auth, 'credentials');
  const email = transferEmail('gemini', payload);
  const expiry = firstNonEmptyString(
    auth.expiry,
    auth.expires_at,
    auth.expiry_date,
    payload.expiry,
    payload.expires_at,
    payload.expiry_date,
    credentials.expiry,
    credentials.expires_at,
    credentials.expiry_date,
    authCredentials.expiry,
    authCredentials.expires_at,
    authCredentials.expiry_date
  );
  const out = removeEmptyValues({
    access_token: firstNonEmptyString(
      auth.access_token,
      auth.accessToken,
      payload.access_token,
      payload.accessToken,
      credentials.access_token,
      credentials.accessToken,
      authCredentials.access_token,
      authCredentials.accessToken
    ),
    refresh_token: firstNonEmptyString(
      auth.refresh_token,
      auth.refreshToken,
      payload.refresh_token,
      payload.refreshToken,
      credentials.refresh_token,
      credentials.refreshToken,
      authCredentials.refresh_token,
      authCredentials.refreshToken
    ),
    id_token: firstNonEmptyString(
      auth.id_token,
      auth.idToken,
      payload.id_token,
      payload.idToken,
      credentials.id_token,
      credentials.idToken,
      authCredentials.id_token,
      authCredentials.idToken
    ),
    client_id: firstNonEmptyString(
      auth.client_id,
      auth.clientId,
      payload.client_id,
      payload.clientId,
      credentials.client_id,
      credentials.clientId,
      authCredentials.client_id,
      authCredentials.clientId
    ),
    email
  });
  if (expiry) out.expiry = expiry;
  const epoch = Number(expiry);
  if (Number.isFinite(epoch) && epoch > 0) {
    out.expires_at = epoch;
    out.expiry_date = epoch;
  }
  return out;
}

module.exports = Object.freeze({
  id: 'gemini',
  capability: 'provider.credentials',
  // 原生凭据里没有比邮箱更稳定的字段：邮箱即身份（账号描述对象也可据邮箱出种子）。
  emailIsIdentity: true,
  extractNativeAuth: (source) => {
    const email = String(source.googleAccounts && source.googleAccounts.active || '').trim();
    return source.oauthCreds ? { ...source.oauthCreds, ...(email ? { email } : {}) } : null;
  },
  nativeIdentitySeed: (auth) => emailIdentitySeed('gemini', auth),
  importAliases: ['google'],
  transferEmailCandidates: (fields, helpers) => [
    ...genericEmailCandidates(fields),
    ...profileEmailCandidates(fields.source),
    helpers.extractEmailFromJwt(fields.source.id_token || fields.source.idToken || fields.tokens.id_token),
    helpers.extractEmailFromJwt(fields.source.access_token || fields.source.accessToken || fields.tokens.access_token)
  ],
  transferIdentitySeed: (auth) => emailIdentitySeed('gemini', auth),
  exportRecord: (nativeAuth, helpers) => {
    const auth = objectOrEmpty(nativeAuth.oauthCreds);
    return {
      auth,
      meta: {
        email: helpers.extractOAuthEmail('gemini', auth),
        clientId: String(auth.client_id || '').trim(),
        expiresAt: parseJwtExpiryMs(auth.access_token) || null
      }
    };
  },
  exportOAuthKind: (auth) => (firstNonEmptyString(auth.access_token, auth.refresh_token) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => removeEmptyValues({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
    id_token: auth.id_token,
    client_id: auth.client_id,
    email: transferEmail('gemini', auth)
  }),
  importApiKeyEnv: (config) => apiKeyEnvFromFacts('gemini', config),
  importNativeAuth: (auth) => ({ oauthCreds: auth }),
  normalizeImportedOAuth: (account) => normalizeGeminiOAuthAuth(account)
});
