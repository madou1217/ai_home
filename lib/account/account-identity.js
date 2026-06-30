'use strict';

// Single source of truth for "how do we identify an account".
//
// There are TWO distinct keys, and conflating them is what caused the historical
// "multiple sources of truth" bug:
//
//  1. Runtime key  — `${provider}:${accountId}`. A throwaway in-memory index used
//     within a single server load. accountId is a mutable CLI quick-switch index,
//     so this key is NOT stable across re-imports/renumbering. It must keep its
//     single-colon shape because several call sites serialize it into wire
//     objects and parse it back by splitting on the first colon
//     (upstream-endpoints.js, codex-adapter.js). Use getRuntimeAccountKey.
//
//  2. unique_key   — a STABLE content fingerprint that survives accountId changes,
//     used as the model catalog persistence key:
//       OAuth   -> `oauth:${provider}:${email}`        (matches transfer-core dedup)
//       api-key -> `api_key:${provider}:${baseUrl}:${sha256(key)[:16]}` (secret hashed)
//     Derived from on-disk credentials only (no network probe). When neither an
//     email nor a provider-native id is available yet, it degrades to
//     `legacy:${provider}:${accountId}` (marked degraded) so a later load can
//     upgrade it once the identity becomes known.

const crypto = require('node:crypto');
const {
  normalizeProvider,
  normalizeBaseUrl,
  buildOAuthIdentity,
  buildApiKeyIdentity
} = require('./transfer-core');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('./claude-credential');

// ---------------------------------------------------------------------------
// Small fs helpers (pure, fs passed in) — kept local so this module has no
// dependency on standard-transfer (which instead imports the identity fns below).
// ---------------------------------------------------------------------------

function readJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch (_error) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Runtime key (in-memory `${provider}:${accountId}` — format intentionally fixed)
// ---------------------------------------------------------------------------

function getAccountId(accountOrId) {
  if (accountOrId && typeof accountOrId === 'object') {
    return String(accountOrId.id || accountOrId.accountId || '').trim();
  }
  return String(accountOrId || '').trim();
}

function getRuntimeAccountKey(provider, accountOrId) {
  const normalizedProvider = normalizeProvider(provider);
  const accountId = getAccountId(accountOrId);
  return normalizedProvider && accountId ? `${normalizedProvider}:${accountId}` : '';
}

function parseRuntimeAccountKey(key) {
  const text = String(key || '').trim();
  const index = text.indexOf(':');
  if (index <= 0) return { provider: '', accountId: '', accountKey: '' };
  const provider = normalizeProvider(text.slice(0, index));
  const accountId = text.slice(index + 1).trim();
  return provider && accountId
    ? { provider, accountId, accountKey: `${provider}:${accountId}` }
    : { provider: '', accountId: '', accountKey: '' };
}

// ---------------------------------------------------------------------------
// Stable identity from on-disk credentials (relocated from standard-transfer.js;
// behaviour is byte-identical so import dedup stays correct).
// ---------------------------------------------------------------------------

function readStoredOAuthAuth({ fs, path, provider, profileDir, configDir }) {
  if (provider === 'codex') return readJsonFileSafe(fs, path.join(configDir, 'auth.json'));
  if (provider === 'gemini') return readJsonFileSafe(fs, path.join(profileDir, '.gemini', 'oauth_creds.json'));
  if (provider === 'claude') return readJsonFileSafe(fs, path.join(configDir, '.credentials.json'));
  if (provider === 'agy') {
    const auth = readJsonFileSafe(fs, path.join(configDir, 'antigravity-oauth-token'));
    const email = readTextFileSafe(fs, path.join(configDir, 'email.cache'));
    return auth && email && !auth.email ? { ...auth, email } : auth;
  }
  if (provider === 'opencode') return readJsonFileSafe(fs, path.join(profileDir, '.local', 'share', 'opencode', 'auth.json'));
  return null;
}

function buildIdentityFromStoredRecord({ fs, path, provider, accountId, getProfileDir, getToolConfigDir, identityKind }) {
  const profileDir = getProfileDir(provider, accountId);
  const configDir = getToolConfigDir(provider, accountId);
  if (identityKind === 'auth-token' && provider === 'claude') {
    const config = readJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};
    const credential = readClaudeCredential({ env: config });
    return credential.token
      ? `auth_token:claude:${normalizeBaseUrl(credential.baseUrl)}:${credential.token}`
      : '';
  }
  if (identityKind === 'api-key') {
    const config = readJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};
    const auth = provider === 'codex'
      ? (readJsonFileSafe(fs, path.join(configDir, 'auth.json')) || {})
      : {};
    return buildApiKeyIdentity(provider, { config, auth });
  }
  const auth = readStoredOAuthAuth({ fs, path, provider, profileDir, configDir });
  if (!auth) return '';
  const emailIdentity = buildOAuthIdentity(provider, auth);
  if (emailIdentity) return emailIdentity;
  if (provider === 'opencode') return buildOpenCodeAuthUniqueKey(auth);
  return '';
}

// ---------------------------------------------------------------------------
// Provider-native stable ids (read from creds, no probe). Used only as an OAuth
// fallback when the email is not yet known.
// ---------------------------------------------------------------------------

function extractClaudeNativeId(auth) {
  const oauth = auth && (auth.claudeAiOauth || auth.claude_ai_oauth);
  const account = oauth && oauth.account;
  const uuid = account && (account.uuid || account.account_uuid || account.accountUuid);
  return String(uuid || '').trim();
}

function extractCodexNativeId(auth) {
  const direct = auth && (auth.account_id || auth.accountId);
  if (direct) return String(direct).trim();
  const tokens = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
  const fromTokens = tokens && (tokens.account_id || tokens.chatgpt_account_id);
  return String(fromTokens || '').trim();
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
  const publicId = firstOpenCodeString(record, ['email', 'account_id', 'accountId', 'id', 'username']);
  if (publicId) return `${provider}:${type}:id:${publicId.toLowerCase()}`;

  const key = firstOpenCodeString(record, ['key', 'apiKey', 'api_key', 'access_key']);
  if (key) return `${provider}:${type}:key:${hashApiKeySecret(key)}`;

  const stableRecord = {};
  Object.keys(record).sort().forEach((keyName) => {
    const normalized = keyName.toLowerCase();
    if (normalized.includes('token') || normalized.includes('expires') || normalized === 'expired') return;
    stableRecord[keyName] = record[keyName];
  });
  if (type === 'unknown' && Object.keys(stableRecord).length < 1) return '';
  return `${provider}:${type}:record:${crypto.createHash('sha256').update(JSON.stringify(stableRecord)).digest('hex').slice(0, 16)}`;
}

function buildOpenCodeAuthUniqueKey(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  const entries = Object.entries(auth)
    .map(([providerName, record]) => buildOpenCodeProviderIdentity(providerName, record))
    .filter(Boolean)
    .sort();
  if (entries.length < 1) return '';
  const digest = crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
  return `oauth:opencode:auth:${digest}`;
}

// ---------------------------------------------------------------------------
// Persisted unique_key derivation
// ---------------------------------------------------------------------------

function hashApiKeySecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 16);
}

// Convert a raw transfer-core identity into the persisted form. OAuth identities
// carry no secret and pass through. For api-key identities we DROP the key
// entirely and keep only `api_key:${provider}:${baseUrl}`: an api-key account is
// identified by where it points, not by the secret. So rotating the key is the
// SAME account — its per-model on/off settings are preserved (a model that was
// disabled stays disabled after a key rotation), and the raw secret never lands
// in model catalog state. (Trade-off: two api-key accounts that share the
// exact same provider+baseUrl are treated as one identity for settings.)
function toPersistedUniqueKey(rawIdentity) {
  const text = String(rawIdentity || '').trim();
  if (!text) return '';
  if (!text.startsWith('api_key:') && !text.startsWith('auth_token:')) return text;
  // *_key:${provider}:${baseUrl}:${rawKey} — drop the trailing key segment.
  const lastColon = text.lastIndexOf(':');
  if (lastColon <= text.indexOf(':') + 1) return text;
  return text.slice(0, lastColon);
}

function buildLegacyUniqueKey(provider, accountId) {
  const normalizedProvider = normalizeProvider(provider);
  const id = String(accountId || '').trim();
  return normalizedProvider && id ? `legacy:${normalizedProvider}:${id}` : '';
}

function isDegradedUniqueKey(uniqueKey) {
  return String(uniqueKey || '').startsWith('legacy:');
}

function inferIdentityKind(account) {
  if (account && String(account.credentialType || account.authMode || account.authType || '').trim().toLowerCase() === 'auth-token') return 'auth-token';
  if (account && (account.apiKeyMode || account.authType === 'api-key')) return 'api-key';
  return 'oauth';
}

// Detect api-key vs oauth from on-disk creds (no account object needed), mirroring
// the server loaders: a provider API key present in .aih_env.json => api-key.
const PROVIDER_API_KEY_ENV = {
  codex: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  agy: [],
  opencode: []
};

function detectIdentityKind({ fs, path, provider, profileDir }) {
  if (provider === 'claude' && fs && path && profileDir) {
    const env = readJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};
    const credential = readClaudeCredential({ env });
    if (credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN && credential.token) return 'auth-token';
    if (credential.apiKey) return 'api-key';
    return 'oauth';
  }
  const keys = PROVIDER_API_KEY_ENV[provider] || [];
  if (keys.length === 0 || !fs || !path || !profileDir) return 'oauth';
  const env = readJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};
  return keys.some((key) => String(env[key] || '').trim()) ? 'api-key' : 'oauth';
}

// Resolve the stable unique_key for an account from on-disk credentials.
// Returns { uniqueKey, kind, degraded }. Never throws.
function resolveAccountUniqueKey(input) {
  const {
    fs,
    path,
    provider,
    accountId,
    getProfileDir,
    getToolConfigDir
  } = input || {};
  const normalizedProvider = normalizeProvider(provider);
  const id = String(accountId || '').trim();
  if (!normalizedProvider || !id || !fs || !path || typeof getProfileDir !== 'function' || typeof getToolConfigDir !== 'function') {
    return { uniqueKey: '', kind: '', degraded: true };
  }

  const identityKind = input.identityKind === 'api-key' || input.identityKind === 'auth-token' || input.identityKind === 'oauth'
    ? input.identityKind
    : detectIdentityKind({ fs, path, provider: normalizedProvider, profileDir: getProfileDir(normalizedProvider, id) });

  // api-key/auth-token: baseUrl + key are always on disk -> never degrades.
  if (identityKind === 'api-key' || identityKind === 'auth-token') {
    const raw = buildIdentityFromStoredRecord({
      fs, path, provider: normalizedProvider, accountId: id, getProfileDir, getToolConfigDir, identityKind
    });
    const uniqueKey = toPersistedUniqueKey(raw);
    if (uniqueKey) return { uniqueKey, kind: identityKind, degraded: false };
    return { uniqueKey: buildLegacyUniqueKey(normalizedProvider, id), kind: 'legacy', degraded: true };
  }

  // oauth ladder: email -> provider-native id -> legacy(accountId).
  const emailIdentity = buildIdentityFromStoredRecord({
    fs, path, provider: normalizedProvider, accountId: id, getProfileDir, getToolConfigDir, identityKind: 'oauth'
  });
  if (emailIdentity) return { uniqueKey: emailIdentity, kind: 'oauth', degraded: false };

  const profileDir = getProfileDir(normalizedProvider, id);
  const configDir = getToolConfigDir(normalizedProvider, id);
  const auth = readStoredOAuthAuth({ fs, path, provider: normalizedProvider, profileDir, configDir });
  if (auth) {
    if (normalizedProvider === 'opencode') {
      const uniqueKey = buildOpenCodeAuthUniqueKey(auth);
      if (uniqueKey) return { uniqueKey, kind: 'oauth', degraded: false };
    }
    if (normalizedProvider === 'claude') {
      const uuid = extractClaudeNativeId(auth);
      if (uuid) return { uniqueKey: `oauth:claude:uuid:${uuid}`, kind: 'oauth', degraded: false };
    } else if (normalizedProvider === 'codex') {
      const nativeId = extractCodexNativeId(auth);
      if (nativeId) return { uniqueKey: `oauth:codex:acct:${nativeId}`, kind: 'oauth', degraded: false };
    }
  }

  return { uniqueKey: buildLegacyUniqueKey(normalizedProvider, id), kind: 'legacy', degraded: true };
}

// Best-effort identity from a loaded account object (no fs access). Used only by
// callers that cannot reach the credential files; prefer resolveAccountUniqueKey.
function resolveAccountUniqueKeyFromObject(account) {
  const provider = normalizeProvider(account && account.provider);
  const accountId = getAccountId(account);
  if (!provider) return { uniqueKey: '', kind: '', degraded: true };
  const kind = inferIdentityKind(account);

  if (kind === 'api-key' || kind === 'auth-token') {
    // Key-independent identity (see toPersistedUniqueKey): rotating the secret
    // keeps the same account so per-model settings survive.
    const baseUrl = normalizeBaseUrl(account && (account.baseUrl || account.openaiBaseUrl));
    const hasSecret = String((account && account.accessToken) || '').trim();
    if (hasSecret) {
      const prefix = kind === 'auth-token' ? 'auth_token' : 'api_key';
      return { uniqueKey: `${prefix}:${provider}:${baseUrl}`, kind, degraded: false };
    }
    return { uniqueKey: buildLegacyUniqueKey(provider, accountId), kind: 'legacy', degraded: true };
  }

  const email = String((account && account.email) || '').trim().toLowerCase();
  if (email && email.includes('@')) {
    return { uniqueKey: `oauth:${provider}:${email}`, kind: 'oauth', degraded: false };
  }
  return { uniqueKey: buildLegacyUniqueKey(provider, accountId), kind: 'legacy', degraded: true };
}

function parseUniqueKey(uniqueKey) {
  const text = String(uniqueKey || '').trim();
  if (!text) return { kind: '', provider: '', email: null, baseUrl: null, keyHash: null, nativeId: null };

  if (text.startsWith('oauth:')) {
    const rest = text.slice('oauth:'.length);
    const firstColon = rest.indexOf(':');
    const provider = normalizeProvider(rest.slice(0, firstColon));
    const remainder = rest.slice(firstColon + 1);
    // oauth:provider:uuid:<id> / oauth:provider:acct:<id> are native-id forms.
    if (remainder.startsWith('uuid:') || remainder.startsWith('acct:')) {
      return { kind: 'oauth', provider, email: null, baseUrl: null, keyHash: null, nativeId: remainder.slice(5) };
    }
    return { kind: 'oauth', provider, email: remainder, baseUrl: null, keyHash: null, nativeId: null };
  }

  if (text.startsWith('api_key:')) {
    // api_key:${provider}:${baseUrl} — baseUrl is everything after the provider
    // (it can itself contain colons, e.g. https://...). No secret/hash segment.
    const rest = text.slice('api_key:'.length);
    const firstColon = rest.indexOf(':');
    const provider = normalizeProvider(firstColon >= 0 ? rest.slice(0, firstColon) : rest);
    const baseUrl = firstColon >= 0 ? rest.slice(firstColon + 1) : '';
    return { kind: 'api-key', provider, email: null, baseUrl, keyHash: null, nativeId: null };
  }

  if (text.startsWith('auth_token:')) {
    const rest = text.slice('auth_token:'.length);
    const firstColon = rest.indexOf(':');
    const provider = normalizeProvider(firstColon >= 0 ? rest.slice(0, firstColon) : rest);
    const baseUrl = firstColon >= 0 ? rest.slice(firstColon + 1) : '';
    return { kind: 'auth-token', provider, email: null, baseUrl, keyHash: null, nativeId: null };
  }

  if (text.startsWith('legacy:')) {
    const parsed = parseRuntimeAccountKey(text.slice('legacy:'.length));
    return { kind: 'legacy', provider: parsed.provider, email: null, baseUrl: null, keyHash: null, nativeId: null };
  }

  return { kind: '', provider: '', email: null, baseUrl: null, keyHash: null, nativeId: null };
}

module.exports = {
  // runtime key
  normalizeProvider,
  getAccountId,
  getRuntimeAccountKey,
  parseRuntimeAccountKey,
  // stable identity (also re-exported by standard-transfer for dedup)
  readStoredOAuthAuth,
  buildIdentityFromStoredRecord,
  // unique_key
  resolveAccountUniqueKey,
  resolveAccountUniqueKeyFromObject,
  detectIdentityKind,
  hashApiKeySecret,
  buildOpenCodeAuthUniqueKey,
  toPersistedUniqueKey,
  parseUniqueKey,
  isDegradedUniqueKey,
  buildLegacyUniqueKey,
  extractClaudeNativeId,
  extractCodexNativeId
};
