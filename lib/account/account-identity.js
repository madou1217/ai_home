'use strict';

// Single source of truth for "how do we identify an account".
//
// accountRef is the persisted and runtime account key. cliAccountId exists solely
// as a human-friendly CLI selector. accountRef is derived once,
//     during registration, from a stable identity seed:
//       Codex OAuth -> `oauth:codex:${userId}`          (see the ADR below)
//       other OAuth -> Provider-specific stable subject policy (email only for explicit exceptions)
//       api-key     -> `api_key:${provider}:${baseUrl}:${sha256(key)[:16]}` (secret hashed)
//     Derived from credentials before registration (no network probe). Accounts
//     without a stable identity are rejected instead of falling back to a CLI id.
//
// Codex OAuth is deliberately NOT on the email vector: email changes, and §8.1
// of docs/architecture/product-direction-node-go-2026-08-15.md forbids letting
// accountRef change with it. The vector is `oauth:codex:<user_id>`, byte-identical
// to Go's, pinned by contracts/codex-oauth-identity.json. See
// docs/architecture/codex-oauth-identity-vector-adr.md.

const crypto = require('node:crypto');
const {
  normalizeProvider,
  normalizeBaseUrl,
  buildOAuthIdentity,
  extractOAuthEmail
} = require('./transfer-core');
const {
  buildCodexOAuthIdentitySeed
} = require('./codex-auth-metadata');
const {
  normalizeEmailComponent,
  normalizeUuidComponent
} = require('./identity-components');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('./claude-credential');
const {
  isQoderProvider,
  resolveQoderNativeAuthPayload,
  buildQoderIdentitySeed
} = require('./qoder-auth-metadata');
const {
  readAccountCredentials
} = require('../server/account-credential-store');
const { buildGrokIdentitySeed } = require('./grok-identity');
const { readKimiOAuthCredentials } = require('./kimi-auth');
const { buildOpenCodeIdentitySeed } = require('./opencode-identity');
const { buildKimiIdentitySeed, buildZcodeIdentitySeed, buildCodebuddyIdentitySeed } = require('./subject-oauth-identity');
const { buildKiroIdentitySeed } = require('./kiro-identity');

function readCredentialConfigEnv(fs, aiHomeDir, accountRef) {
  return readAccountCredentials(fs, aiHomeDir, accountRef);
}

// ---------------------------------------------------------------------------
// Provider-native stable ids (read from creds, no probe). Claude can expose a
// stable account UUID; Codex upstream account_id remains credential metadata
// and is never used to derive the local accountRef.
// ---------------------------------------------------------------------------

function extractClaudeNativeId(auth) {
  const oauth = auth && (auth.claudeAiOauth || auth.claude_ai_oauth);
  const account = oauth && oauth.account;
  const uuid = account && (account.uuid || account.account_uuid || account.accountUuid);
  // 与 Go 的 normalizeUUID 逐条对齐：原值必须已经 trim、必须匹配 UUID 形状、统一小写。
  // 少任何一条都会让同一个账号在两端派生出不同的 accountRef —— 尤其**小写**：
  // 大写 UUID 会让 Node 造出一个 Go 永远不会产生的种子。
  return normalizeUuidComponent(uuid);
}

// ---------------------------------------------------------------------------
// Registration identity-seed derivation
// ---------------------------------------------------------------------------

function hashApiKeySecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 16);
}

// Convert a raw transfer-core identity into the persisted form. OAuth identities
// carry no secret and pass through. API-key and auth-token identities retain a
// short hash of the secret so two accounts at the same endpoint remain distinct,
// while the raw secret never lands in account metadata.
function normalizeIdentitySeed(rawIdentity) {
  const text = String(rawIdentity || '').trim();
  if (!text) return '';
  if (!text.startsWith('api_key:') && !text.startsWith('auth_token:')) return text;
  // buildApiKeyIdentity URL-encodes the final component so colons inside a
  // secret cannot be mistaken for part of the endpoint.
  const lastColon = text.lastIndexOf(':');
  if (lastColon <= text.indexOf(':') + 1) return text;
  let secret = '';
  try {
    secret = decodeURIComponent(text.slice(lastColon + 1));
  } catch (_error) {
    return '';
  }
  return secret ? `${text.slice(0, lastColon)}:${hashApiKeySecret(secret)}` : '';
}

function inferIdentityKind(account) {
  if (account && String(account.credentialType || account.authMode || account.authType || '').trim().toLowerCase() === 'auth-token') return 'auth-token';
  if (account && (account.apiKeyMode || account.authType === 'api-key')) return 'api-key';
  return 'oauth';
}

// Detect api-key vs oauth from DB creds (no account object needed), mirroring
// the server loaders: a provider API key present in app-state.db => api-key.
const PROVIDER_API_KEY_ENV = {
  codex: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  agy: [],
  // OpenCode: 依据 OPENCODE_API_KEY 识别 API Key 模式（原生映射 ~/.local/share/opencode/auth.json）
  opencode: ['OPENCODE_API_KEY'],
  grok: ['XAI_API_KEY'],
  qoder: ['QODER_PERSONAL_ACCESS_TOKEN'],
  qodercn: ['QODER_PERSONAL_ACCESS_TOKEN'],
  kimi: ['MOONSHOT_API_KEY'],
  kiro: [],
  zcode: ['ZCODE_API_KEY'],
  // CodeBuddy 家族：国际站 / 国内站 / WorkBuddy（国际站 + 国内站）共用同一组
  // env 凭据键（同一套 CodeBuddy Code runtime），但账号体系互不相通，
  // 因此各自独立登记，不合并成一个 Provider。
  codebuddy: ['CODEBUDDY_API_KEY'],
  codebuddycn: ['CODEBUDDY_API_KEY'],
  workbuddy: ['CODEBUDDY_API_KEY'],
  workbuddycn: ['CODEBUDDY_API_KEY']
};

// CodeBuddy 家族（国际站 / 国内站 / WorkBuddy 国际站 / WorkBuddy 国内站）：
// 原生凭据载荷形状相同（credentials/oAuth 或共享 .info 的 account + auth），
// 但身份种子前缀按站点区分。
const CODEBUDDY_FAMILY_PROVIDERS = Object.freeze([
  'codebuddy',
  'codebuddycn',
  'workbuddy',
  'workbuddycn'
]);

function isCodebuddyFamilyProvider(provider) {
  return CODEBUDDY_FAMILY_PROVIDERS.includes(String(provider || '').trim().toLowerCase());
}

function detectIdentityKind({ fs, aiHomeDir, provider, accountRef }) {
  if (provider === 'claude' && fs && aiHomeDir && accountRef) {
    const env = readCredentialConfigEnv(fs, aiHomeDir, accountRef);
    const credential = readClaudeCredential({ env });
    if (credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN && credential.token) return 'auth-token';
    if (credential.apiKey) return 'api-key';
    return 'oauth';
  }
  const keys = PROVIDER_API_KEY_ENV[provider] || [];
  if (keys.length === 0 || !fs || !aiHomeDir || !accountRef) return 'oauth';
  const env = readCredentialConfigEnv(fs, aiHomeDir, accountRef);
  return keys.some((key) => String(env[key] || '').trim()) ? 'api-key' : 'oauth';
}

function resolveNativeAuthIdentitySeed(provider, nativeAuth) {
  const normalizedProvider = normalizeProvider(provider);
  const source = nativeAuth && typeof nativeAuth === 'object' && !Array.isArray(nativeAuth)
    ? nativeAuth
    : {};
  let auth = null;
  if (normalizedProvider === 'codex') auth = source.auth || null;
  else if (normalizedProvider === 'claude') auth = source.credentials || null;
  else if (normalizedProvider === 'gemini') {
    const email = String(source.googleAccounts && source.googleAccounts.active || '').trim();
    auth = source.oauthCreds
      ? { ...source.oauthCreds, ...(email ? { email } : {}) }
      : null;
  } else if (normalizedProvider === 'agy') {
    const email = String(source.email || '').trim();
    auth = source.oauthToken
      ? { ...source.oauthToken, ...(email ? { email } : {}) }
      : null;
  } else if (normalizedProvider === 'opencode') auth = source.auth || null;
  else if (normalizedProvider === 'grok') auth = source.auth || null;
  else if (normalizedProvider === 'kimi') auth = readKimiOAuthCredentials(source);
  else if (normalizedProvider === 'kiro') auth = source.auth || null;
  else if (normalizedProvider === 'zcode') auth = source.credentials || null;
  // CodeBuddy 家族的三个 Provider 原生凭据形状相同，但站点/产品各不相同，
  // 身份种子前缀由 buildCodebuddyIdentitySeed 按 provider 区分。
  else if (isCodebuddyFamilyProvider(normalizedProvider)) auth = source.credentials || null;
  else if (isQoderProvider(normalizedProvider)) {
    auth = resolveQoderNativeAuthPayload(normalizedProvider, source);
  }
  if (!auth) {
    // Qoder PAT-only accounts may store the token in env, not native auth.
    if (isQoderProvider(normalizedProvider) && source && source.pat) {
      const digest = crypto.createHash('sha256').update(String(source.pat)).digest('hex').slice(0, 16);
      return { identitySeed: `api_key:${normalizedProvider}:pat:${digest}`, kind: 'api-key', degraded: false };
    }
    return { identitySeed: '', kind: '', degraded: true };
  }

  if (isQoderProvider(normalizedProvider)) {
    const identitySeed = buildQoderIdentitySeed(normalizedProvider, auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }

  // Codex OAuth 的身份向量是 `oauth:codex:<user_id>`，与 Go 逐字节一致；邮箱只用于展示
  // 与导入关联，不参与身份。必须放在下面通用的 email 分支之前，否则 codex 会被 email
  // 分支抢先命中。见 docs/architecture/codex-oauth-identity-vector-adr.md。
  if (normalizedProvider === 'codex') {
    const identitySeed = buildCodexOAuthIdentitySeed(auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }

  // Claude OAuth 的身份向量是 `oauth:claude:uuid:<account_uuid>`（§8.1 的表格明文规定），
  // 邮箱不参与。必须放在下面通用的 email 分支**之前**，否则带 `claudeAiOauth.email` 的凭据
  // 会走邮箱向量——那是 Go 永远不会产生的种子。
  //
  // 拿不到合法 UUID 时**不回退邮箱**：§8.1 要求「稳定字段必须存在，缺失时返回
  // identity_unverifiable」。Go 侧同样拒绝。
  if (normalizedProvider === 'claude') {
    const nativeId = extractClaudeNativeId(auth);
    return nativeId
      ? { identitySeed: `oauth:claude:uuid:${nativeId}`, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }

  // AGY（Antigravity）的原生 oauthToken 文档里**没有**比邮箱更稳定的字段，所以邮箱是它的
  // 唯一可用身份——这是 §8.1 表格未覆盖的例外，需要单独论证（见 ADR 的「未覆盖项」）。
  //
  // 但**校验强度**必须与 Go 对齐：Go 的 normalizeEmail 会拒绝非邮箱形状的值，
  // 而 Node 原先只做 trim + lowercase，于是会铸出 Go 永远不会产生的种子
  // （`oauth:agy:no-at-sign` 之类）。
  if (normalizedProvider === 'agy') {
    const email = normalizeEmailComponent(extractOAuthEmail('agy', auth));
    return email
      ? { identitySeed: `oauth:agy:${email}`, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }

  if (normalizedProvider === 'grok') {
    const identitySeed = buildGrokIdentitySeed(auth);
    return identitySeed ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }

  // Only the documented Gemini exception may derive identity from email.
  // A generic email shortcut here previously bypassed stable Provider policies.
  if (normalizedProvider === 'gemini') {
    const email = normalizeEmailComponent(extractOAuthEmail('gemini', auth));
    return email ? { identitySeed: `oauth:gemini:${email}`, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  if (normalizedProvider === 'opencode') {
    const identitySeed = buildOpenCodeIdentitySeed(auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  if (normalizedProvider === 'kimi') {
    const identitySeed = buildKimiIdentitySeed(auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  if (normalizedProvider === 'kiro') {
    const identitySeed = buildKiroIdentitySeed(source);
    return identitySeed ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  if (normalizedProvider === 'zcode') {
    const identitySeed = buildZcodeIdentitySeed(auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  if (isCodebuddyFamilyProvider(normalizedProvider)) {
    const identitySeed = buildCodebuddyIdentitySeed(normalizedProvider, auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  return { identitySeed: '', kind: '', degraded: true };
}

// Identity derivation for a newly submitted API-key/token account before its
// credential record exists. Existing accounts are resolved by accountRef.
function resolveIdentitySeedFromAccount(account) {
  const provider = normalizeProvider(account && account.provider);
  if (!provider) return { identitySeed: '', kind: '', degraded: true };
  const kind = inferIdentityKind(account);

  if (kind === 'api-key' || kind === 'auth-token') {
    const baseUrl = normalizeBaseUrl(account && (account.baseUrl || account.openaiBaseUrl));
    const secret = String((account && account.accessToken) || '').trim();
    if (secret) {
      const prefix = kind === 'auth-token' ? 'auth_token' : 'api_key';
      return {
        identitySeed: `${prefix}:${provider}:${baseUrl}:${hashApiKeySecret(secret)}`,
        kind,
        degraded: false
      };
    }
    return { identitySeed: '', kind: '', degraded: true };
  }

  // Codex 的 OAuth 身份来自 ID Token 里的稳定 user_id，而一个账号描述对象只有邮箱——
  // 邮箱不是身份（§8.1 明文禁止回退邮箱），所以这里**拒绝**而不是铸出
  // `oauth:codex:<email>`。调用方必须走凭据那条路（那里才有 id_token）。
  //
  // 这条分支在生产里目前不可达（唯一的调用方只走 api-key），但它是导出/提交路径上
  // 最容易再长出旧向量的地方，所以显式封死。
  if (!['agy', 'gemini'].includes(provider)) {
    return { identitySeed: '', kind: '', degraded: true };
  }

  const email = String((account && account.email) || '').trim().toLowerCase();
  if (email && email.includes('@')) {
    return { identitySeed: `oauth:${provider}:${email}`, kind: 'oauth', degraded: false };
  }
  return { identitySeed: '', kind: '', degraded: true };
}

module.exports = {
  // registration identity seed
  resolveNativeAuthIdentitySeed,
  resolveIdentitySeedFromAccount,
  detectIdentityKind,
  hashApiKeySecret,
  buildOpenCodeIdentitySeed,
  buildKimiIdentitySeed,
  buildZcodeIdentitySeed,
  normalizeIdentitySeed,
  extractClaudeNativeId
};
