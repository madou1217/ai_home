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
    chatgptAccountId: String(authClaim.chatgpt_account_id || authJson.chatgpt_account_id || tokens.account_id || '').trim(),
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
  const planType = firstNonEmptyString(input && input.planType, metadata && metadata.planType);
  const email = firstNonEmptyString(input && input.email, metadata && metadata.email);
  const accountId = firstNonEmptyString(
    input && (input.accountId || input.account_id),
    metadata && metadata.chatgptAccountId,
    tokens && tokens.account_id
  );
  const organizationId = firstNonEmptyString(
    input && (input.organizationId || input.organization_id),
    metadata && metadata.organizationId
  );
  if (!planType && !email && !accountId && !organizationId) return null;
  return {
    planType,
    email,
    accountId,
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

module.exports = {
  DEFAULT_CODEX_CLIENT_ID,
  decodeJwtPayloadUnsafe,
  parseIsoTimestampMs,
  parseJwtExpiryMs,
  extractCodexMetadata,
  buildCodexSnapshotAccount,
  buildCodexMetadataFallbackSnapshot
};
