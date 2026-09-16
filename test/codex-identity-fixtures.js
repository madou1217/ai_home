'use strict';

// Shared fixtures for the Codex OAuth identity vector.
//
// The vector is `oauth:codex:<user_id>` — see
// docs/architecture/codex-oauth-identity-vector-adr.md and the cross-language pin
// in contracts/codex-oauth-identity.json.
//
// Why a shared module: an email alone is no longer an identity, so every test
// that needs a codex OAuth account must now supply an ID token carrying a user
// id. Re-deriving that token inline in each suite is how the suites drift apart
// again — which is the exact failure mode the ADR exists to remove.

const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const CODEX_AUTH_CLAIM_NAMESPACE = 'https://api.openai.com/auth';

const DEFAULT_CODEX_EMAIL = 'native@example.com';
const DEFAULT_CODEX_USER_ID = 'user-native-1';

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// buildCodexIdToken 生成测试用 ID Token。只有 payload 有意义，签名是占位符——
// 领域层只解析 claim，不验证签名。
function buildCodexIdToken(payload) {
  return [
    base64UrlJson({ alg: 'none', typ: 'JWT' }),
    base64UrlJson(payload),
    'signature'
  ].join('.');
}

// codexAuthClaim 构造 `https://api.openai.com/auth` 命名空间下的 claim。
function codexAuthClaim(claims = {}) {
  return { [CODEX_AUTH_CLAIM_NAMESPACE]: { ...claims } };
}

// codexOAuthAuth 构造 auth.json 形态的凭据（`tokens` + 可选的展示邮箱）。
//
// 传 `userId: null` 可得到一个「没有稳定用户 ID」的凭据，用于断言
// `identity_unverifiable`——邮箱不能顶上。
function codexOAuthAuth(options = {}) {
  const userId = options.userId === undefined ? DEFAULT_CODEX_USER_ID : options.userId;
  const email = options.email === undefined ? DEFAULT_CODEX_EMAIL : options.email;
  const accessToken = options.accessToken || 'secret-token';
  const refreshToken = options.refreshToken || 'secret-refresh-token';
  const sub = options.sub;

  const payload = {
    ...(sub ? { sub } : {}),
    ...(email ? { email } : {}),
    ...codexAuthClaim(userId === null
      ? (options.authClaims || {})
      : { chatgpt_user_id: userId, ...(options.authClaims || {}) })
  };

  return {
    ...(email ? { email } : {}),
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: options.idToken || buildCodexIdToken(payload)
    }
  };
}

// codexIdentitySeed 从用户 ID 派生身份种子。
function codexIdentitySeed(userId) {
  return `oauth:codex:${userId}`;
}

// codexAccountRef 从用户 ID 派生 accountRef，避免各测试各自重算向量。
function codexAccountRef(userId) {
  return getPublicAccountRef(`unique:${codexIdentitySeed(userId)}`);
}

module.exports = {
  CODEX_AUTH_CLAIM_NAMESPACE,
  DEFAULT_CODEX_EMAIL,
  DEFAULT_CODEX_USER_ID,
  buildCodexIdToken,
  codexAccountRef,
  codexAuthClaim,
  codexIdentitySeed,
  codexOAuthAuth
};
