'use strict';

const { buildCodexOAuthIdentitySeed, extractCodexMetadata, normalizeCodexRefreshToken } = require('../codex-auth-metadata');
const { genericEmailCandidates, objectOrEmpty, removeEmptyValues } = require('./transfer-fields');
const { transferEmail } = require('./email-identity');
const { apiKeyEnvFromFacts } = require('./import-env');
const { goStaticAccountIdentity } = require('../go-bridge/go-static-account-ref');

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
  },
  sub2apiCredentials: (auth, record) => {
    const tokens = objectOrEmpty(auth.tokens);
    const credentials = {
      access_token: String(tokens.access_token || '').trim(),
      refresh_token: String(tokens.refresh_token || '').trim(),
      id_token: String(tokens.id_token || '').trim(),
      chatgpt_account_id: String(tokens.account_id || '').trim()
    };
    if (record.meta && record.meta.planType) credentials.plan_type = record.meta.planType;
    const email = transferEmail('codex', auth);
    if (email) credentials.email = email;
    return removeEmptyValues(credentials);
  },
  importApiKeyEnv: (config) => apiKeyEnvFromFacts('codex', config),
  // 宿主 API Key 槽位（扫描本机账号用）：codex 用 `codex login --with-api-key` 写进 auth.json 的
  // OPENAI_API_KEY；带 OAuth tokens 的 auth.json 是登录态，不当 API Key 账号。
  hostApiKeySlots: Object.freeze([Object.freeze({
    path: Object.freeze(['.codex', 'auth.json']),
    format: 'json',
    select: (doc) => {
      const tokens = doc && doc.tokens && typeof doc.tokens === 'object' ? doc.tokens : null;
      if (tokens && (tokens.refresh_token || tokens.access_token)) return null;
      const apiKey = typeof doc.OPENAI_API_KEY === 'string' ? doc.OPENAI_API_KEY.trim() : '';
      return apiKey ? { apiKey, credentialType: 'api-key' } : null;
    }
  })]),
  importNativeAuth: (auth) => ({ auth }),
  // Go 持久化快照 -> Node 凭据布局，不再借已废弃的 sub2api HTTP 导出。
  goAccountImports: Object.freeze({
    'api_key:': ({ credential }) => ({
      identitySeed: goStaticAccountIdentity('codex', 'api_key', credential.api_key, credential.base_url)?.seed,
      env: apiKeyEnvFromFacts('codex', { apiKey: credential.api_key, baseUrl: credential.base_url })
    }),
    'oauth:': ({ credential }) => ({
      nativeAuth: {
        auth: {
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            access_token: credential.access_token,
            refresh_token: credential.refresh_token,
            id_token: credential.id_token,
            account_id: credential.explicit_account_id
          },
          // 凭据代际来自源记录，不能把收养时间冒充 token 刷新时间。
          last_refresh: new Date(credential.refreshed_at_ms).toISOString()
        }
      }
    })
  }),
  normalizeImportedOAuth: (account) => {
    const rawAuth = account && account.auth && typeof account.auth === 'object' ? { ...account, ...account.auth } : account;
    return require('../transfer-core').normalizeCodexAuthPayload(rawAuth);
  }
});
