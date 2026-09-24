'use strict';

// Node 账号记录 -> Go 管理 API 导入请求（Strategy：每个 Provider/认证类型一个转换函数）。
// 这是两个账号库之间唯一的防腐层：Node 的 env_json / native_auth_json 形态只在这里
// 被翻译成 Go 的官方 artifact / sub2api / 静态凭据 DTO，Go 的身份派生与校验保持权威。

const { resolveNativeAuthIdentitySeed } = require('../account-identity');
const { readClaudeCredential, readClaudeOauthCredential } = require('../claude-credential');
const { resolveCodexWorkspace } = require('../codex-workspace');
const { goAccountRefFromSeed, goStaticAccountIdentity } = require('./go-static-account-ref');

const NATIVE_IMPORT_PATH = '/v1/management/account-imports';
const SUB2API_IMPORT_PATH = '/v1/management/account-imports/sub2api';
const STATIC_CREATE_PATH = '/v1/management/accounts';

// Go 以 {native_auth_json} 原样承接的 Provider（nativeaccount.decodeExtended / decodeAGY）。
const NATIVE_ENVELOPE_PROVIDERS = new Set([
  'agy', 'gemini', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro', 'zcode',
  'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'
]);

// Go 无法表示、迁移后会静默丢失的 Codex API Key 扩展字段。
const CODEX_LOSSY_ENV_KEYS = ['OPENAI_WIRE_API', 'AIH_UPSTREAM_HEADERS', 'AIH_IMAGE_API'];

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unsupported(record, reason) {
  return { kind: 'unsupported', provider: record.provider, nodeRef: record.accountRef, reason };
}

function sub2apiDocument(name, platform, type, credentials, exportedAt) {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: exportedAt,
    proxies: [],
    accounts: [{ name, platform, type, credentials, concurrency: 0, priority: 0 }]
  };
}

function importPlan(record, fields) {
  return {
    kind: 'import',
    provider: record.provider,
    nodeRef: record.accountRef,
    lossy: [],
    workspace: null,
    ...fields
  };
}

function predictedRefFromSeed(seed) {
  return seed ? goAccountRefFromSeed(seed) : '';
}

function accountName(record) {
  return `${record.provider}-${record.cliAccountId || record.accountRef}`;
}

function translateCodex(record, options) {
  const apiKey = text(record.env.OPENAI_API_KEY);
  if (apiKey) {
    const baseUrl = text(record.env.OPENAI_BASE_URL);
    const identity = goStaticAccountIdentity('codex', 'api_key', apiKey, baseUrl);
    return importPlan(record, {
      authClass: 'api_key',
      request: {
        method: 'POST',
        path: SUB2API_IMPORT_PATH,
        body: sub2apiDocument(accountName(record), 'openai', 'apikey', { api_key: apiKey, base_url: baseUrl }, options.exportedAt)
      },
      predictedGoRef: identity ? identity.accountRef : '',
      lossy: CODEX_LOSSY_ENV_KEYS.filter((key) => text(record.env[key])),
      secrets: { apiKey, baseUrl: identity ? identity.baseUrl : '' }
    });
  }
  const auth = record.nativeAuth.auth;
  if (!isNonEmptyObject(auth) || !isNonEmptyObject(auth.tokens)) return unsupported(record, 'codex_credentials_missing');
  const workspace = resolveCodexWorkspace(auth);
  if (!workspace.ok) return unsupported(record, workspace.error);
  const tokens = auth.tokens;
  // Node 旧导入形态把显式工作区放在顶层 chatgpt_account_id；Go 只认 tokens.account_id。
  const goAuth = { ...auth, tokens: { ...tokens } };
  if (!text(tokens.account_id) && text(auth.chatgpt_account_id)) goAuth.tokens.account_id = text(auth.chatgpt_account_id);
  const seed = resolveNativeAuthIdentitySeed('codex', record.nativeAuth);
  return importPlan(record, {
    authClass: 'oauth',
    request: { method: 'POST', path: NATIVE_IMPORT_PATH, body: { provider_id: 'codex', artifacts: { auth_json: goAuth } } },
    predictedGoRef: predictedRefFromSeed(seed),
    workspace: { workspaceId: workspace.workspaceId, upstreamAccountId: workspace.upstreamAccountId },
    secrets: {
      accessToken: text(tokens.access_token),
      refreshToken: text(tokens.refresh_token),
      idToken: text(tokens.id_token)
    }
  });
}

function translateClaudeStatic(record, credential) {
  const baseUrl = credential.baseUrl;
  if (credential.credentialType === 'auth-token') {
    const identity = goStaticAccountIdentity('claude', 'auth_token', credential.authToken, baseUrl);
    return importPlan(record, {
      authClass: 'auth_token',
      request: {
        method: 'POST',
        path: STATIC_CREATE_PATH,
        body: { provider_id: 'claude', auth: { kind: 'auth_token', auth_token: credential.authToken, base_url: baseUrl } }
      },
      predictedGoRef: identity ? identity.accountRef : '',
      secrets: { authToken: credential.authToken, baseUrl: identity ? identity.baseUrl : '' }
    });
  }
  const identity = goStaticAccountIdentity('claude', 'api_key', credential.apiKey, baseUrl);
  return importPlan(record, {
    authClass: 'api_key',
    request: {
      method: 'POST',
      path: SUB2API_IMPORT_PATH,
      body: sub2apiDocument(accountName(record), 'anthropic', 'apikey', { api_key: credential.apiKey, base_url: baseUrl }, record.exportedAt)
    },
    predictedGoRef: identity ? identity.accountRef : '',
    secrets: { apiKey: credential.apiKey, baseUrl: identity ? identity.baseUrl : '' }
  });
}

function translateClaude(record, options) {
  const credential = readClaudeCredential({ env: record.env });
  if (credential.configured) return translateClaudeStatic({ ...record, exportedAt: options.exportedAt }, credential);

  const oauth = readClaudeOauthCredential(record.nativeAuth, { nowMs: 0 });
  if (!oauth.accessToken || !oauth.refreshToken || !(oauth.expiresAt > 0)) {
    return unsupported(record, 'claude_oauth_incomplete');
  }
  const raw = oauth.oauth || {};
  const account = raw.account && typeof raw.account === 'object' ? raw.account : {};
  const accountUuid = text(account.uuid || account.account_uuid || account.accountUuid);
  const emailAddress = text(account.emailAddress || account.email_address || account.email);
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((scope) => typeof scope === 'string' && scope) : [];
  if (!accountUuid) return unsupported(record, 'claude_oauth_account_uuid_missing');
  if (!emailAddress) return unsupported(record, 'claude_oauth_email_missing');
  if (scopes.length === 0) return unsupported(record, 'claude_oauth_scopes_missing');

  const claudeAiOauth = {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: Math.trunc(oauth.expiresAt),
    scopes
  };
  if (oauth.refreshTokenExpiresAt > 0) claudeAiOauth.refreshTokenExpiresAt = Math.trunc(oauth.refreshTokenExpiresAt);
  for (const [goKey, values] of [
    ['subscriptionType', [raw.subscriptionType, raw.subscription_type]],
    ['rateLimitTier', [raw.rateLimitTier, raw.rate_limit_tier]],
    ['clientId', [raw.clientId, raw.client_id]]
  ]) {
    const value = values.map(text).find(Boolean);
    if (value) claudeAiOauth[goKey] = value;
  }
  const oauthAccount = { accountUuid, emailAddress };
  const organizationUuid = text(account.organizationUuid || account.organization_uuid);
  const organizationName = text(account.organizationName || account.organization_name);
  if (organizationUuid) oauthAccount.organizationUuid = organizationUuid;
  if (organizationName) oauthAccount.organizationName = organizationName;

  const seed = resolveNativeAuthIdentitySeed('claude', record.nativeAuth);
  return importPlan(record, {
    authClass: 'oauth',
    request: {
      method: 'POST',
      path: NATIVE_IMPORT_PATH,
      body: {
        provider_id: 'claude',
        artifacts: { credentials_json: { claudeAiOauth }, global_config_json: { oauthAccount } }
      }
    },
    predictedGoRef: predictedRefFromSeed(seed),
    secrets: { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken }
  });
}

function translateNativeEnvelope(record) {
  if (!isNonEmptyObject(record.nativeAuth)) {
    // Go 对这些 Provider 只支持原生登录态；Node 的 API Key / Vertex 账号继续由 Node 承接。
    return unsupported(record, isNonEmptyObject(record.env) ? 'go_has_no_static_credential_for_provider' : 'credentials_missing');
  }
  const seed = resolveNativeAuthIdentitySeed(record.provider, record.nativeAuth);
  return importPlan(record, {
    authClass: 'native',
    request: {
      method: 'POST',
      path: NATIVE_IMPORT_PATH,
      body: { provider_id: record.provider, artifacts: { native_auth_json: record.nativeAuth } }
    },
    predictedGoRef: predictedRefFromSeed(seed),
    secrets: { nativeAuth: record.nativeAuth }
  });
}

const STRATEGIES = Object.freeze({
  codex: translateCodex,
  claude: translateClaude
});

/**
 * @param {object} record node-account-reader 的一条账号记录
 * @param {{exportedAt?: string}} options
 */
function translateNodeAccount(record, options = {}) {
  const exportedAt = options.exportedAt || new Date().toISOString();
  const strategy = STRATEGIES[record.provider];
  if (strategy) return strategy(record, { exportedAt });
  if (NATIVE_ENVELOPE_PROVIDERS.has(record.provider)) return translateNativeEnvelope(record);
  return unsupported(record, 'provider_not_supported_by_go');
}

module.exports = {
  NATIVE_IMPORT_PATH,
  STATIC_CREATE_PATH,
  SUB2API_IMPORT_PATH,
  translateNodeAccount
};
