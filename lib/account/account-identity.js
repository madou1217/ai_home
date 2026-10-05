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
  normalizeBaseUrl
} = require('./transfer-core');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('./claude-credential');
const {
  readAccountCredentials
} = require('../server/account-credential-store');
const { getProviderCredentialFacts } = require('../provider-catalog');
const { getProviderCredentialStrategy } = require('./provider-credentials');

function readCredentialConfigEnv(fs, aiHomeDir, accountRef) {
  return readAccountCredentials(fs, aiHomeDir, accountRef);
}

// ---------------------------------------------------------------------------
// Provider-native stable ids (read from creds, no probe). Claude can expose a
// stable account UUID; Codex upstream account_id remains credential metadata
// and is never used to derive the local accountRef.
// ---------------------------------------------------------------------------


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


function detectIdentityKind({ fs, aiHomeDir, provider, accountRef }) {
  if (provider === 'claude' && fs && aiHomeDir && accountRef) {
    const env = readCredentialConfigEnv(fs, aiHomeDir, accountRef);
    const credential = readClaudeCredential({ env });
    if (credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN && credential.token) return 'auth-token';
    if (credential.apiKey) return 'api-key';
    return 'oauth';
  }
  // Detect api-key vs oauth from DB creds (no account object needed), mirroring
  // the server loaders: a provider API key present in app-state.db => api-key.
  const keys = getProviderCredentialFacts(provider).apiKeyEnv;
  if (keys.length === 0 || !fs || !aiHomeDir || !accountRef) return 'oauth';
  const env = readCredentialConfigEnv(fs, aiHomeDir, accountRef);
  return keys.some((key) => String(env[key] || '').trim()) ? 'api-key' : 'oauth';
}

// 原生凭据 → 稳定身份种子。每家 provider 取哪份载荷、按什么规则出种子，由凭据端口
// （./provider-credentials）里该 provider 的模块决定；这里只负责统一的结果形状。
function resolveNativeAuthIdentitySeed(provider, nativeAuth) {
  const normalizedProvider = normalizeProvider(provider);
  const source = nativeAuth && typeof nativeAuth === 'object' && !Array.isArray(nativeAuth)
    ? nativeAuth
    : {};
  const strategy = getProviderCredentialStrategy(normalizedProvider);
  const auth = strategy.extractNativeAuth(source);
  if (!auth) {
    const fallback = typeof strategy.fallbackIdentity === 'function' ? strategy.fallbackIdentity(source) : null;
    return fallback && fallback.identitySeed
      ? { identitySeed: fallback.identitySeed, kind: fallback.kind, degraded: false }
      : { identitySeed: '', kind: '', degraded: true };
  }
  const identitySeed = strategy.nativeIdentitySeed(auth, { provider: normalizedProvider, source });
  return identitySeed
    ? { identitySeed, kind: 'oauth', degraded: false }
    : { identitySeed: '', kind: '', degraded: true };
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
  if (!getProviderCredentialStrategy(provider).emailIsIdentity) {
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
  normalizeIdentitySeed
};
