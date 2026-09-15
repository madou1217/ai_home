'use strict';

// Timestamps describe a credential generation, not the time it was copied into
// a database or restored from a backup. JWT decoding here is metadata parsing,
// not signature verification; sources must remain local, trusted auth stores.
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { decodeJwtPayloadUnsafe } = require('./codex-auth-metadata');
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function token(value) {
  return typeof value === 'string' && !/[\r\n\0]/.test(value) ? value.trim() : '';
}
function timestampMs(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : 0;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return 0;
  const n = Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function inspectCodexCredential(auth, nowMs = Date.now()) {
  const source = object(auth);
  const tokens = object(source.tokens);
  const accessToken = token(tokens.access_token);
  const refreshToken = token(tokens.refresh_token);
  const payload = object(decodeJwtPayloadUnsafe(accessToken));
  const idPayload = object(decodeJwtPayloadUnsafe(token(tokens.id_token)));
  const accessClaim = object(payload['https://api.openai.com/auth']);
  const idClaim = object(idPayload['https://api.openai.com/auth']);
  // Check like-for-like claims only; a user id is not a workspace/account id.
  const accountIds = [accessClaim.chatgpt_account_id, idClaim.chatgpt_account_id, tokens.account_id, source.chatgpt_account_id]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  const userIds = [accessClaim.chatgpt_user_id, idClaim.chatgpt_user_id]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  const emails = [source.email, source.auth && source.auth.email, source.credentials && source.credentials.email,
    source.config && source.config.email, source.meta && source.meta.email,
    object(payload['https://api.openai.com/profile']).email, payload.email, idPayload.email]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().toLowerCase());
  const issuedAt = Number(payload.iat) > 0 ? Number(payload.iat) * 1000 : 0;
  const expiresAt = Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  const refreshedAt = timestampMs(source.last_refresh);
  let reason = '';
  if (token(source.OPENAI_API_KEY) || source.auth_mode === 'apikey') reason = 'not_oauth';
  else if (!accessToken || !refreshToken) reason = 'incomplete_credentials';
  else if (new Set(accountIds).size > 1 || new Set(userIds).size > 1 || new Set(emails).size > 1) reason = 'inconsistent_identity_claims';
  else if ([issuedAt, refreshedAt].some(n => !Number.isFinite(n) || n > nowMs + MAX_CLOCK_SKEW_MS)) reason = 'future_credential_timestamp';
  // An offline App login may already need access-token renewal. Retain a
  // newer complete grant; the existing refresh executor validates it upstream.
  else if (!issuedAt && !refreshedAt) reason = 'credential_time_unknown';
  return { usable: !reason, reason, issuedAt, refreshedAt, expiresAt, tokens };
}
function codexCredentialFingerprint(auth) {
  const values = object(object(auth).tokens);
  return crypto.createHash('sha256').update(JSON.stringify([
    values.access_token || '', values.refresh_token || '', values.id_token || '', values.account_id || ''
  ])).digest('hex');
}
function compareCodexCredentialSnapshots(current, incoming, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const next = inspectCodexCredential(incoming, nowMs);
  if (!next.usable) return { adopt: false, reason: next.reason };
  const old = inspectCodexCredential(current, nowMs);
  if (isDeepStrictEqual(object(current).tokens, object(incoming).tokens)) {
    return { adopt: false, reason: 'unchanged' };
  }
  if (!token(old.tokens.access_token) || !token(old.tokens.refresh_token)) {
    return { adopt: true, reason: 'database_credentials_missing' };
  }
  // Do not compare expiry as generation: older grants can have longer lifetimes.
  // Do not compare nativeAuthUpdatedAt or file mtime as generation either.
  if (old.issuedAt && next.issuedAt && old.issuedAt !== next.issuedAt) {
    return { adopt: next.issuedAt > old.issuedAt, reason: next.issuedAt > old.issuedAt ? 'newer_token_issued_at' : 'older_token_issued_at' };
  }
  if (old.refreshedAt && next.refreshedAt && old.refreshedAt !== next.refreshedAt) {
    return { adopt: next.refreshedAt > old.refreshedAt, reason: next.refreshedAt > old.refreshedAt ? 'newer_last_refresh' : 'older_last_refresh' };
  }
  return { adopt: false, reason: 'credential_time_ambiguous' };
}
module.exports = { codexCredentialFingerprint, inspectCodexCredential, compareCodexCredentialSnapshots, timestampMs };
