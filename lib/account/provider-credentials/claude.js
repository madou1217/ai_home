'use strict';

const { normalizeUuidComponent } = require('../identity-components');
const { parseJwtExpiryMs } = require('../codex-auth-metadata');
const {
  firstNonEmptyString,
  genericEmailCandidates,
  hasNonEmptyObject,
  objectOrEmpty,
  profileEmailCandidates
} = require('./transfer-fields');

function extractClaudeNativeId(auth) {
  const oauth = auth && (auth.claudeAiOauth || auth.claude_ai_oauth);
  const account = oauth && oauth.account;
  const uuid = account && (account.uuid || account.account_uuid || account.accountUuid);
  return normalizeUuidComponent(uuid);
}

module.exports = Object.freeze({
  id: 'claude',
  capability: 'provider.credentials',
  extractNativeAuth: (source) => source.credentials || null,
  // Claude OAuth 的身份向量是 `oauth:claude:uuid:<account_uuid>`（§8.1 的表格明文规定），
  // 邮箱不参与：带 `claudeAiOauth.email` 的凭据走邮箱向量会铸出 Go 永远不会产生的种子。
  // 拿不到合法 UUID 时不回退邮箱——§8.1 要求稳定字段缺失时返回 identity_unverifiable，Go 侧同样拒绝。
  nativeIdentitySeed: (auth) => {
    const nativeId = extractClaudeNativeId(auth);
    return nativeId ? `oauth:claude:uuid:${nativeId}` : '';
  },
  importAliases: ['anthropic'],
  // 导入的凭据可能多包一层 credentials。
  transferIdentitySeed: (auth) => {
    const oauth = auth.claudeAiOauth || auth.claude_ai_oauth || auth.credentials?.claudeAiOauth;
    const account = oauth?.account;
    const uuid = normalizeUuidComponent(account?.uuid || account?.account_uuid || account?.accountUuid);
    return uuid ? `oauth:claude:uuid:${uuid}` : '';
  },
  transferEmailCandidates: (fields, helpers) => {
    const oauth = fields.source.claudeAiOauth || fields.source.claude_ai_oauth || {};
    return [
      ...genericEmailCandidates(fields),
      ...profileEmailCandidates(fields.source),
      oauth.email,
      helpers.extractEmailFromJwt(oauth.idToken || oauth.id_token),
      helpers.extractEmailFromJwt(oauth.accessToken || oauth.access_token),
      helpers.extractEmailFromJwt(fields.source.access_token || fields.source.accessToken || fields.tokens.access_token)
    ];
  },
  // Claude 兼容端点的 Bearer 令牌在导入时识别为 auth-token 凭据。
  importCredentialEnv: Object.freeze({ keys: ['ANTHROPIC_AUTH_TOKEN'], credentialType: 'auth-token' }),
  exportRecord: (nativeAuth, helpers) => {
    const auth = objectOrEmpty(nativeAuth.credentials);
    const oauth = auth.claudeAiOauth || auth.claude_ai_oauth || {};
    return {
      auth,
      meta: {
        email: helpers.extractOAuthEmail('claude', auth),
        expiresAt: parseJwtExpiryMs(oauth.accessToken || oauth.access_token) || null
      }
    };
  },
  exportOAuthKind: (auth) => {
    const oauth = auth.claudeAiOauth || auth.claude_ai_oauth || {};
    return hasNonEmptyObject(oauth) && firstNonEmptyString(oauth.accessToken, oauth.access_token, oauth.refreshToken, oauth.refresh_token)
      ? 'oauth'
      : '';
  },
  extractClaudeNativeId
});
