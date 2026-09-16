'use strict';

const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function decodeBase64UrlJsonSegment(segment) {
  const text = String(segment || '').trim();
  if (!text) return null;
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function decodeJwtPayloadUnsafe(jwt) {
  const text = String(jwt || '').trim();
  const parts = text.split('.');
  if (parts.length < 2) return null;
  return decodeBase64UrlJsonSegment(parts[1]);
}

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  return epochMs;
}

function parseJwtExpiryMs(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  const expSeconds = Number(payload && payload.exp);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
  return expSeconds * 1000;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeCodexRefreshToken(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

function extractCodexMetadata(authJson) {
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : {};
  const accessPayload = decodeJwtPayloadUnsafe(tokens.access_token);
  const idPayload = decodeJwtPayloadUnsafe(tokens.id_token);
  const authClaim = (accessPayload && accessPayload['https://api.openai.com/auth']) || (idPayload && idPayload['https://api.openai.com/auth']) || {};
  const profileClaim = (accessPayload && accessPayload['https://api.openai.com/profile']) || {};
  const organizations = Array.isArray(authClaim.organizations) ? authClaim.organizations : [];
  const defaultOrg = organizations.find((item) => item && item.is_default) || organizations[0] || null;

  return {
    email: String((profileClaim && profileClaim.email) || (idPayload && idPayload.email) || '').trim(),
    planType: String(authClaim.chatgpt_plan_type || '').trim(),
    clientId: String((accessPayload && accessPayload.client_id) || DEFAULT_CODEX_CLIENT_ID).trim(),
    upstreamAccountId: String(authClaim.chatgpt_account_id || authJson.chatgpt_account_id || tokens.account_id || '').trim(),
    chatgptUserId: String(authClaim.chatgpt_user_id || authJson.chatgpt_user_id || '').trim(),
    userId: String(authClaim.user_id || '').trim(),
    organizationId: String(authJson.organization_id || (defaultOrg && defaultOrg.id) || '').trim(),
    expiresAt: parseJwtExpiryMs(tokens.access_token) || parseIsoTimestampMs(authJson.expired) || null
  };
}

function buildCodexSnapshotAccount(account, authJson) {
  const input = account && typeof account === 'object' ? account : null;
  const metadata = authJson && typeof authJson === 'object' ? extractCodexMetadata(authJson) : null;
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  const planType = firstNonEmptyString(metadata && metadata.planType, input && input.planType);
  const email = firstNonEmptyString(metadata && metadata.email, input && input.email);
  const upstreamAccountId = firstNonEmptyString(
    metadata && metadata.upstreamAccountId,
    input && input.upstreamAccountId,
    tokens && tokens.account_id
  );
  const organizationId = firstNonEmptyString(
    metadata && metadata.organizationId,
    input && input.organizationId
  );
  if (!planType && !email && !upstreamAccountId && !organizationId) return null;
  return {
    planType,
    email,
    upstreamAccountId,
    organizationId
  };
}

function buildCodexMetadataFallbackSnapshot(options = {}) {
  const snapshotAccount = buildCodexSnapshotAccount(options.account, options.authJson);
  if (!snapshotAccount) return null;
  const { planType, email } = snapshotAccount;
  const labelParts = [];
  if (planType) labelParts.push(`plan:${planType}`);
  if (email) labelParts.push(email);
  const fallbackLabel = labelParts.join(' ').trim() || 'account';
  return {
    schemaVersion: Number(options.schemaVersion) || 2,
    kind: 'codex_oauth_status',
    capturedAt: Number(options.capturedAt) || Date.now(),
    source: String(options.source || 'codex_app_server').trim() || 'codex_app_server',
    fallbackSource: String(options.fallbackSource || 'auth_json').trim() || 'auth_json',
    account: snapshotAccount,
    entries: [{
      bucket: 'account',
      windowMinutes: 0,
      window: fallbackLabel,
      remainingPct: null,
      resetIn: 'unknown'
    }]
  };
}

// ---------------------------------------------------------------------------
// Codex OAuth identity vector
// ---------------------------------------------------------------------------
//
// The identity seed is `oauth:codex:<user_id>` and must stay **byte-identical**
// to Go's `oauthIdentitySeed` (core/accounts/codex/account_profile.go), because
// both sides derive `accountRef` as `acct_` + sha256('unique:' + seed)[:20].
// One differing character yields a different account for the same upstream
// account.
//
// Source of truth is the **ID token**, matching Go's `parseIDTokenProfile`
// (core/accounts/codex/jwt.go), which reads only the ID token's
// `https://api.openai.com/auth` claim and its `sub`. The access token is
// deliberately not consulted for identity: Go does not, so consulting it here
// would let Node mint an `accountRef` for a credential Go reports as
// `identity_unverifiable` — the kind of silent divergence this vector exists
// to remove.
//
// Why user_id and not email: docs/architecture/codex-oauth-identity-vector-adr.md.
const CODEX_AUTH_CLAIM_NAMESPACE = 'https://api.openai.com/auth';

// Go's `strings.TrimSpace` follows `unicode.IsSpace`, which includes U+0085
// (NEL) and U+00A0. JS `.trim()` covers the latter but not NEL, so a leading or
// trailing NEL would otherwise survive here and produce a different seed than
// Go's. The primitives live in identity-components.js because the Claude vector
// needs the same rules; keeping one copy is what stops the two from drifting.
const {
  firstGoTrimmedNonEmpty,
  isIdentityComponent,
  trimGoSpace
} = require('./identity-components');

// Mirrors Go's `isIdentityComponent` (core/accounts/codex/jwt.go:302) plus
// `hasControlCharacter` (core/accounts/codex/oauth.go:273). See
// identity-components.js for the rules.
//
// A value that fails this is `identity_unverifiable` — never a fallback to
// email, per §8.1 of the Node/Go product direction.
function isCodexIdentityComponent(value) {
  return isIdentityComponent(value);
}

// resolveCodexIdentityUserId 复刻 Go 的取值链
// `firstNonEmpty(auth.chatgpt_user_id, auth.user_id, sub)`，**并复用 Go 的验证语义**。
//
// 两个容易写错的细节，都对齐 Go：
//   - `firstNonEmpty` 返回的是**已 trim 的值**，所以这里返回 trimGoSpace 的结果；
//   - 空值（含只由空白组成）被**跳过**并继续看下一个候选，不是直接判失败。
//
// 但**已选定**的候选如果非法（含 `:`、控制字符、U+FFFD），整条判定失败——Go 在那里
// 返回 `errMissingOAuthUserID` 而不是继续往后试。这条区别是有意的：继续回退会让一个
// 明显损坏的 claim 静默落到 `sub` 上，把一个坏账号伪装成好账号。
//
// 返回空字符串表示「拿不到稳定字段」，调用方必须按 `identity_unverifiable` 处理，
// 不得回退邮箱或其它可变字段。
function resolveCodexIdentityUserId(authJson) {
  const source = authJson && typeof authJson === 'object' ? authJson : {};
  const tokens = source.tokens && typeof source.tokens === 'object' ? source.tokens : {};
  const idToken = firstGoTrimmedNonEmpty(tokens.id_token, tokens.idToken, source.id_token, source.idToken);
  const payload = decodeJwtPayloadUnsafe(idToken);
  if (!payload || typeof payload !== 'object') return '';
  const authClaim = payload[CODEX_AUTH_CLAIM_NAMESPACE];
  const auth = authClaim && typeof authClaim === 'object' ? authClaim : {};
  const userId = firstGoTrimmedNonEmpty(auth.chatgpt_user_id, auth.user_id, payload.sub);
  return isCodexIdentityComponent(userId) ? userId : '';
}

// buildCodexOAuthIdentitySeed 返回 `oauth:codex:<user_id>`；拿不到稳定字段时返回空串。
function buildCodexOAuthIdentitySeed(authJson) {
  const userId = resolveCodexIdentityUserId(authJson);
  return userId ? `oauth:codex:${userId}` : '';
}

module.exports = {
  CODEX_AUTH_CLAIM_NAMESPACE,
  DEFAULT_CODEX_CLIENT_ID,
  buildCodexMetadataFallbackSnapshot,
  buildCodexOAuthIdentitySeed,
  buildCodexSnapshotAccount,
  decodeJwtPayloadUnsafe,
  extractCodexMetadata,
  isCodexIdentityComponent,
  normalizeCodexRefreshToken,
  parseIsoTimestampMs,
  parseJwtExpiryMs,
  resolveCodexIdentityUserId,
  trimGoSpace
};
