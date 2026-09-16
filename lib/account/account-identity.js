'use strict';

// Single source of truth for "how do we identify an account".
//
// accountRef is the persisted and runtime account key. cliAccountId exists solely
// as a human-friendly CLI selector. accountRef is derived once,
//     during registration, from a stable identity seed:
//       Codex OAuth -> `oauth:codex:${userId}`          (see the ADR below)
//       other OAuth -> `oauth:${provider}:${email}`
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
  buildOAuthIdentity
} = require('./transfer-core');
const {
  buildCodexOAuthIdentitySeed
} = require('./codex-auth-metadata');
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
const { listGrokAuthProfiles } = require('./grok-auth-profile');
const { decodeJwtPayloadUnsafe } = require('./codex-auth-metadata');
const { readKimiOAuthCredentials } = require('./kimi-auth');
const { decryptZcodeCredentialRecord } = require('./zcode-credential');

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
  return String(uuid || '').trim();
}

function firstOpenCodeString(record, keys) {
  if (!record || typeof record !== 'object') return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildOpenCodeProviderIdentity(providerName, record) {
  const provider = String(providerName || '').trim().toLowerCase();
  if (!provider || !record || typeof record !== 'object' || Array.isArray(record)) return '';
  const type = String(record.type || 'unknown').trim().toLowerCase() || 'unknown';
  const upstreamIdentity = firstOpenCodeString(record, ['email', 'account_id', 'accountId', 'id', 'username']);
  if (upstreamIdentity) return `${provider}:${type}:id:${upstreamIdentity.toLowerCase()}`;

  const key = firstOpenCodeString(record, ['key', 'apiKey', 'api_key', 'access_key']);
  if (key) return `${provider}:${type}:key:${hashApiKeySecret(key)}`;

  const refreshSecret = firstOpenCodeString(record, ['refresh', 'refresh_token', 'refreshToken']);
  if (refreshSecret) return `${provider}:${type}:refresh:${hashApiKeySecret(refreshSecret)}`;

  const stableRecord = {};
  Object.keys(record).sort().forEach((keyName) => {
    const normalized = keyName.toLowerCase();
    if (
      normalized === 'type'
      || normalized === 'access'
      || normalized === 'refresh'
      || normalized.includes('token')
      || normalized.includes('expires')
      || normalized === 'expired'
    ) return;
    stableRecord[keyName] = record[keyName];
  });
  if (Object.keys(stableRecord).length < 1) return '';
  return `${provider}:${type}:record:${crypto.createHash('sha256').update(JSON.stringify(stableRecord)).digest('hex').slice(0, 16)}`;
}

function buildOpenCodeIdentitySeed(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  const entries = Object.entries(auth)
    .map(([providerName, record]) => buildOpenCodeProviderIdentity(providerName, record))
    .filter(Boolean)
    .sort();
  if (entries.length < 1) return '';
  const digest = crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
  return `oauth:opencode:auth:${digest}`;
}

function buildGrokIdentitySeed(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  const identities = listGrokAuthProfiles(auth).flatMap((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    const email = firstOpenCodeString(record, ['email']).toLowerCase();
    if (email) return [`email:${email}`];
    const stableId = firstOpenCodeString(record, ['user_id', 'principal_id', 'userId', 'principalId']);
    return stableId ? [`id:${stableId}`] : [];
  }).sort();
  if (identities.length < 1) return '';
  const digest = crypto.createHash('sha256').update(identities.join('\n')).digest('hex').slice(0, 16);
  return `oauth:grok:auth:${digest}`;
}

function readKimiTokenSubject(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  return firstOpenCodeString(payload, ['user_id', 'userId', 'sub', 'subject']);
}

function buildKimiIdentitySeed(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return '';
  const directSubjects = [
    firstOpenCodeString(credentials, ['user_id', 'userId']),
    firstOpenCodeString(credentials, ['sub', 'subject'])
  ].filter(Boolean);
  const tokenSubjects = [
    readKimiTokenSubject(credentials.access_token || credentials.accessToken),
    readKimiTokenSubject(credentials.refresh_token || credentials.refreshToken)
  ].filter(Boolean);
  const subjects = Array.from(new Set([...directSubjects, ...tokenSubjects]));
  // Kimi's device_id is deliberately excluded: the same user can authorize
  // multiple devices, while the refresh token and token id are rotated.
  if (subjects.length > 1) return '';
  if (subjects.length === 1) {
    return `oauth:kimi:user:${hashApiKeySecret(subjects[0])}`;
  }
  const stableSecret = firstOpenCodeString(credentials, ['refresh_token', 'refreshToken', 'access_token', 'accessToken']);
  if (!stableSecret) return '';
  return `oauth:kimi:token:${hashApiKeySecret(stableSecret)}`;
}

// 兼容 credentials/oAuth 载荷及共享 .info 的 account + auth 形状。
// 优先比对同类 user id/JWT subject；email/account id 不是 user id，不能混用来
// 判断冲突。没有稳定用户身份时才使用 email 或逐 token 哈希——
// 退化后同一用户重复登录无法去重，但绝不返回错误种子。
//
// provider 参与种子前缀：国内站（codebuddycn）与国际站（codebuddy）的账号体系
// 互不通，同一自然人在两边是不同账号，前缀必须区分，否则去重会把两个站点的
// 账号合并成一个。
function buildCodebuddyIdentitySeed(provider, auth) {
  const normalizedProvider = String(provider || 'codebuddy').trim().toLowerCase() || 'codebuddy';
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  const record = firstPlainObject(auth, [
    'claudeAiOauth',
    'codebuddyOauth',
    'codebuddy_oauth',
    'oauth',
    'auth'
  ]) || auth;
  const directSubjects = [
    firstOpenCodeString(record, ['user_id', 'userId', 'uid']),
    firstOpenCodeString(record, ['sub', 'subject']),
    firstOpenCodeString(auth.account, ['uid', 'user_id', 'userId'])
  ].filter(Boolean);
  const tokenSubjects = [
    readKimiTokenSubject(record.access_token || record.accessToken),
    readKimiTokenSubject(record.refresh_token || record.refreshToken)
  ].filter(Boolean);
  const subjects = Array.from(new Set([...directSubjects, ...tokenSubjects]));
  // 多个互不相同的身份说明凭据里混了不止一个账号，宁可降级也不猜。
  if (subjects.length > 1) return '';
  if (subjects.length === 1) return `oauth:${normalizedProvider}:user:${hashApiKeySecret(subjects[0])}`;
  const email = firstOpenCodeString(record, ['email']).toLowerCase();
  if (email) return `oauth:${normalizedProvider}:user:${hashApiKeySecret(email)}`;
  const accountId = firstOpenCodeString(record, ['account_id', 'accountId']);
  if (accountId) return `oauth:${normalizedProvider}:account:${hashApiKeySecret(accountId)}`;
  const stableSecret = firstOpenCodeString(record, [
    'refresh_token',
    'refreshToken',
    'access_token',
    'accessToken'
  ]);
  return stableSecret
    ? `oauth:${normalizedProvider}:token:${hashApiKeySecret(stableSecret)}`
    : '';
}

// firstPlainObject 返回若干候选键里第一个非空纯对象，用于穿透可选的嵌套载荷。
function firstPlainObject(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function buildZcodeIdentitySeed(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return '';
  const plain = decryptZcodeCredentialRecord(credentials);
  const userInfo = safeParseJsonRecord(plain['oauth:zai:user_info']);
  // user_id/userId 优先；缺失时回退 email（OAuth exchange 的 data.user 已携带），
  // 否则种子退化为逐 token 哈希，同一用户重复登录无法去重。email 统一小写，
  // 保证两次登录大小写不同仍得到同一种子（与 grok 的 email 处理一致）。
  const userInfoId = firstOpenCodeString(userInfo, ['user_id', 'userId'])
    || firstOpenCodeString(userInfo, ['email']).toLowerCase();
  if (userInfoId) return `oauth:zcode:user:${hashApiKeySecret(userInfoId)}`;
  const jwtSubject = readKimiTokenSubject(plain['zcodejwttoken'] || plain['oauth:zai:access_token']);
  if (jwtSubject) return `oauth:zcode:user:${hashApiKeySecret(jwtSubject)}`;
  const stableSecret = firstOpenCodeString(plain, ['zcodejwttoken', 'oauth:zai:access_token']);
  return stableSecret ? `oauth:zcode:token:${hashApiKeySecret(stableSecret)}` : '';
}

function safeParseJsonRecord(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

  const emailIdentity = buildOAuthIdentity(normalizedProvider, auth);
  if (emailIdentity) return { identitySeed: emailIdentity, kind: 'oauth', degraded: false };
  if (normalizedProvider === 'opencode') {
    const identitySeed = buildOpenCodeIdentitySeed(auth);
    return identitySeed
      ? { identitySeed, kind: 'oauth', degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  if (normalizedProvider === 'grok') {
    const identitySeed = buildGrokIdentitySeed(auth);
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
    const stableSecret = firstOpenCodeString(auth, ['refresh_token', 'refreshToken', 'access_token', 'accessToken']);
    return stableSecret
      ? { identitySeed: `oauth:kiro:token:${hashApiKeySecret(stableSecret)}`, kind: 'oauth', degraded: false }
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
  if (normalizedProvider === 'claude') {
    const nativeId = extractClaudeNativeId(auth);
    if (nativeId) return { identitySeed: `oauth:claude:uuid:${nativeId}`, kind: 'oauth', degraded: false };
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
  if (provider === 'codex') {
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
