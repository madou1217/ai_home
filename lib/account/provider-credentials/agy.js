'use strict';

const { emailIdentitySeed } = require('./email-identity');
const {
  firstNonEmptyString,
  genericEmailCandidates,
  isPlainObject,
  objectOrEmpty,
  parseDateMs,
  profileEmailCandidates,
  readNestedObject,
  removeEmptyValues
} = require('./transfer-fields');
const { transferEmail } = require('./email-identity');
const { AGY_CLI_AUTH_METHOD } = require('../agy-auth-metadata');

function normalizeAgyOAuthAuth(account) {
  const payload = isPlainObject(account) ? account : {};
  const auth = readNestedObject(payload, 'auth');
  const credentials = readNestedObject(payload, 'credentials');
  const token = isPlainObject(auth.token)
    ? auth.token
    : (isPlainObject(payload.token) ? payload.token : {});
  const email = transferEmail('agy', payload);
  return removeEmptyValues({
    auth_method: firstNonEmptyString(
      auth.auth_method,
      auth.authMethod,
      payload.auth_method,
      payload.authMethod,
      credentials.auth_method,
      credentials.authMethod
    ) || AGY_CLI_AUTH_METHOD,
    token: removeEmptyValues({
      access_token: firstNonEmptyString(
        token.access_token,
        token.accessToken,
        auth.access_token,
        auth.accessToken,
        payload.access_token,
        payload.accessToken,
        credentials.access_token,
        credentials.accessToken
      ),
      refresh_token: firstNonEmptyString(
        token.refresh_token,
        token.refreshToken,
        auth.refresh_token,
        auth.refreshToken,
        payload.refresh_token,
        payload.refreshToken,
        credentials.refresh_token,
        credentials.refreshToken
      ),
      expiry: firstNonEmptyString(
        token.expiry,
        token.expires_at,
        token.expiry_date,
        auth.expiry,
        auth.expires_at,
        auth.expiry_date,
        payload.expiry,
        payload.expires_at,
        payload.expiry_date,
        credentials.expiry,
        credentials.expires_at,
        credentials.expiry_date
      )
    }),
    email
  });
}

module.exports = Object.freeze({
  id: 'agy',
  capability: 'provider.credentials',
  // 原生凭据里没有比邮箱更稳定的字段：邮箱即身份（账号描述对象也可据邮箱出种子）。
  emailIsIdentity: true,
  extractNativeAuth: (source) => {
    const email = String(source.email || '').trim();
    return source.oauthToken ? { ...source.oauthToken, ...(email ? { email } : {}) } : null;
  },
  // AGY 的原生 oauthToken 没有比邮箱更稳定的字段，邮箱是它唯一可用的身份（见 ADR「未覆盖项」）。
  nativeIdentitySeed: (auth) => emailIdentitySeed('agy', auth),
  importAliases: ['antigravity'],
  transferEmailCandidates: (fields) => [...genericEmailCandidates(fields), ...profileEmailCandidates(fields.source)],
  transferIdentitySeed: (auth) => emailIdentitySeed('agy', auth),
  // Antigravity 访问令牌在导入时识别为 auth-token 凭据。
  importCredentialEnv: Object.freeze({ keys: ['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN'], credentialType: 'auth-token' }),
  exportRecord: (nativeAuth) => {
    const auth = objectOrEmpty(nativeAuth.oauthToken);
    const email = String(nativeAuth.email || '').trim();
    const token = objectOrEmpty(auth.token);
    // 判定可否导出时只带邮箱，不带其余元数据。
    return {
      auth,
      meta: { email, authMode: String(auth.auth_method || '').trim(), expiresAt: parseDateMs(token.expiry) },
      kindMeta: { email }
    };
  },
  // 没有 OAuth 令牌时，env 里的 Antigravity 访问令牌也可导出（access-token 类）。
  exportOAuthKind: (auth, record) => {
    const token = objectOrEmpty(auth.token);
    if (firstNonEmptyString(token.access_token, token.refresh_token)) return 'oauth';
    const config = objectOrEmpty(record && record.config);
    return firstNonEmptyString(config.AGY_ACCESS_TOKEN, config.GOOGLE_OAUTH_ACCESS_TOKEN) ? 'access-token' : '';
  },
  sub2apiCredentials: (auth, record) => {
    const token = objectOrEmpty(auth.token);
    return removeEmptyValues({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expiry,
      email: transferEmail('agy', auth) || (record.meta && record.meta.email)
    });
  },
  // 原生布局把邮箱放在 oauthToken 外层。
  importNativeAuth: (auth) => {
    const email = transferEmail('agy', auth);
    const authToWrite = { ...auth };
    delete authToWrite.email;
    return { oauthToken: authToWrite, ...(email ? { email } : {}) };
  },
  normalizeImportedOAuth: (account) => normalizeAgyOAuthAuth(account)
});
