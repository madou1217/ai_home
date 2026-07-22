'use strict';

// Single source of truth for "how do we identify an account".
//
// accountRef is the persisted and runtime account key. cliAccountId exists solely
// as a human-friendly CLI selector. accountRef is derived once,
//     during registration, from a stable identity seed:
//       OAuth   -> `oauth:${provider}:${email}`        (matches transfer-core dedup)
//       api-key -> `api_key:${provider}:${baseUrl}:${sha256(key)[:16]}` (secret hashed)
//     Derived from credentials before registration (no network probe). Accounts
//     without a stable identity are rejected instead of falling back to a CLI id.

const crypto = require('node:crypto');
const {
  normalizeProvider,
  normalizeBaseUrl,
  buildOAuthIdentity
} = require('./transfer-core');
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
  opencode: [],
  grok: ['XAI_API_KEY'],
  qoder: ['QODER_PERSONAL_ACCESS_TOKEN'],
  qodercn: ['QODER_PERSONAL_ACCESS_TOKEN'],
  kimi: ['MOONSHOT_API_KEY'],
  kiro: []
};

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
  normalizeIdentitySeed,
  extractClaudeNativeId
};
