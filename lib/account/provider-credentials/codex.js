'use strict';

const { buildCodexOAuthIdentitySeed, extractCodexMetadata, normalizeCodexRefreshToken } = require('../codex-auth-metadata');
const { genericEmailCandidates, objectOrEmpty } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'codex',
  capability: 'provider.credentials',
  extractNativeAuth: (source) => source.auth || null,
  // Codex OAuth 的身份向量是 `oauth:codex:<user_id>`，与 Go 逐字节一致；邮箱只用于展示
  // 与导入关联，不参与身份。见 docs/architecture/codex-oauth-identity-vector-adr.md。
  nativeIdentitySeed: (auth) => buildCodexOAuthIdentitySeed(auth),
  importAliases: ['openai', 'chatgpt'],
  transferEmailCandidates: (fields, helpers) => [
    ...genericEmailCandidates(fields),
    helpers.extractCodexMetadata(fields.source).email,
    helpers.extractEmailFromJwt(fields.source.id_token || fields.source.idToken || fields.tokens.id_token),
    helpers.extractEmailFromJwt(fields.source.access_token || fields.source.accessToken || fields.tokens.access_token)
  ],
  transferIdentitySeed: (auth) => buildCodexOAuthIdentitySeed(auth),
  exportRecord: (nativeAuth) => {
    const auth = objectOrEmpty(nativeAuth.auth);
    return { auth, meta: extractCodexMetadata(auth) };
  },
  exportOAuthKind: (auth) => {
    const tokens = objectOrEmpty(auth.tokens);
    return normalizeCodexRefreshToken(tokens.refresh_token) ? 'oauth' : '';
  }
});
