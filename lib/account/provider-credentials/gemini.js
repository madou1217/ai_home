'use strict';

const { emailIdentitySeed } = require('./email-identity');
const { parseJwtExpiryMs } = require('../codex-auth-metadata');
const { firstNonEmptyString, genericEmailCandidates, objectOrEmpty, profileEmailCandidates } = require('./transfer-fields');

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
  exportOAuthKind: (auth) => (firstNonEmptyString(auth.access_token, auth.refresh_token) ? 'oauth' : '')
});
