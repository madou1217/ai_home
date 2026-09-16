'use strict';

// Local .info routing evidence, not JWT signature verification. The upstream
// still authenticates the token. Only fixed, observed issuer origins are used.
const path = require('node:path');
const crypto = require('node:crypto');
const { CODEBUDDY_EXTENSION_AUTH_DIR, CODEBUDDY_CN_SHARED_AUTH_PATH,
  CODEBUDDY_AI_SHARED_AUTH_PATH, CODEBUDDY_INTL_SHARED_AUTH_PATH } = require('../runtime/provider-storage-policy');
const PRIMARY = Object.freeze({ codebuddy: CODEBUDDY_INTL_SHARED_AUTH_PATH,
  codebuddycn: CODEBUDDY_CN_SHARED_AUTH_PATH, workbuddy: CODEBUDDY_AI_SHARED_AUTH_PATH,
  workbuddycn: CODEBUDDY_CN_SHARED_AUTH_PATH });
const ISSUERS = Object.freeze({
  'https://www.codebuddy.ai/auth/realms/copilot': ['codebuddy'],
  'https://www.workbuddy.ai/auth/realms/copilot': ['workbuddy'],
  'https://www.workbuddy.cn/auth/realms/copilot': ['codebuddycn', 'workbuddycn'],
  'https://www.codebuddy.cn/auth/realms/copilot': ['codebuddycn', 'workbuddycn'],
  'https://copilot.tencent.com/auth/realms/copilot': ['codebuddycn', 'workbuddycn']
});
const MAX_BYTES = 1024 * 1024;
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = value => typeof value === 'string' ? value.trim() : '';
function claims(token) {
  if (!text(token) || token.length > MAX_BYTES) return null;
  try { const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); return plain(value) ? value : null; }
  catch (_) { return null; }
}
function inspectCodebuddyCredential(value, provider = '', nowMs = Date.now()) {
  if (!plain(value) || !plain(value.auth) || !plain(value.account)) return { ok: false, reason: 'unsupported_credential_shape' };
  const access = claims(value.auth.accessToken), refresh = claims(value.auth.refreshToken);
  if (!access || !ISSUERS[access.iss]) return { ok: false, reason: 'unrecognized_credential_realm' };
  if (provider && !ISSUERS[access.iss].includes(provider)) return { ok: false, reason: 'credential_realm_mismatch' };
  if (!text(value.auth.refreshToken)) return { ok: false, reason: 'incomplete_oauth_credential' };
  const uid = text(value.account.uid), subject = text(access.sub);
  if (!uid || uid !== subject || /[\x00-\x20\x7f]/.test(uid) || (refresh && refresh.sub && refresh.sub !== uid)) {
    return { ok: false, reason: 'credential_identity_mismatch' };
  }
  const domain = new URL(access.iss).hostname;
  if (text(value.auth.domain).toLowerCase() !== domain) return { ok: false, reason: 'credential_domain_mismatch' };
  if (refresh && refresh.iss && refresh.iss !== access.iss) return { ok: false, reason: 'refresh_realm_mismatch' };
  const iat = Number(access.iat) * 1000, exp = Number(access.exp) * 1000;
  const refreshed = Number(value.auth.lastRefreshTime);
  if (!Number.isFinite(iat) || iat <= 0 || iat > nowMs + 120000 || (Number.isFinite(exp) && exp < iat)) {
    return { ok: false, reason: 'credential_time_invalid' };
  }
  return { ok: true, uid, issuer: access.iss, domain, providers: ISSUERS[access.iss],
    scope: `${access.iss}\n${uid}`, issuedAt: iat, expiresAt: Number.isFinite(exp) ? exp : 0,
    refreshedAt: Number.isFinite(refreshed) && refreshed > 0 && refreshed <= nowMs + 120000 ? refreshed : 0,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify([value.auth.accessToken, value.auth.refreshToken || ''])).digest('hex') };
}
function compareCodebuddyCredentials(current, next, provider, nowMs = Date.now()) {
  const fresh = inspectCodebuddyCredential(next, provider, nowMs);
  if (!fresh.ok) return { adopt: false, reason: fresh.reason };
  const previous = inspectCodebuddyCredential(current, provider, nowMs);
  if (!current || !Object.keys(current).length) return fresh.expiresAt && fresh.expiresAt <= nowMs
    ? { adopt: false, reason: 'candidate_credential_expired' } : { adopt: true, reason: 'initial_credential' };
  if (!previous.ok) return { adopt: false, reason: 'stored_credential_unverifiable' };
  if (previous.scope !== fresh.scope) return { adopt: false, reason: 'credential_identity_mismatch' };
  if (previous.fingerprint === fresh.fingerprint) return { adopt: false, reason: 'unchanged' };
  if (fresh.expiresAt && fresh.expiresAt <= nowMs) return { adopt: false, reason: 'candidate_credential_expired' };
  if (fresh.issuedAt !== previous.issuedAt) return { adopt: fresh.issuedAt > previous.issuedAt, reason: fresh.issuedAt > previous.issuedAt ? 'newer_issued_at' : 'older_credential' };
  if (fresh.refreshedAt && previous.refreshedAt && fresh.refreshedAt !== previous.refreshedAt) {
    return { adopt: fresh.refreshedAt > previous.refreshedAt, reason: fresh.refreshedAt > previous.refreshedAt ? 'newer_refresh_time' : 'older_credential' };
  }
  return { adopt: false, reason: 'credential_time_ambiguous' };
}
function readCodebuddyCredentialFile(fs, file, provider = '', nowMs = Date.now()) {
  try {
    const a = fs.lstatSync(file);
    if (!a.isFile() || a.isSymbolicLink() || a.size > MAX_BYTES) return { ok: false, reason: 'unsupported_credential_file' };
    const raw = fs.readFileSync(file, 'utf8'), b = fs.lstatSync(file);
    if (['ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => a[key] !== b[key])) return { ok: false, reason: 'credential_file_changed' };
    if (Buffer.byteLength(raw) > MAX_BYTES) return { ok: false, reason: 'credential_file_too_large' };
    const credential = JSON.parse(raw), inspection = inspectCodebuddyCredential(credential, provider, nowMs);
    return inspection.ok ? { ...inspection, credential, hostId: path.basename(file, '.info') } : inspection;
  } catch (error) { return { ok: false, reason: error.code === 'ENOENT' ? 'credential_file_missing' : 'credential_file_unreadable' }; }
}
function codebuddyCredentialPaths(home, provider) {
  if (!PRIMARY[provider] || !home) return [];
  const files = [path.join(home, ...PRIMARY[provider])];
  if (provider.endsWith('cn')) files.push(path.join(home, ...CODEBUDDY_INTL_SHARED_AUTH_PATH));
  return [...new Set(files)];
}
function selectCodebuddyCredential(fs, home, provider, options = {}) {
  const now = options.nowMs || Date.now(), expected = options.expected && inspectCodebuddyCredential(options.expected, provider, now);
  let best = null, reason = 'credential_file_missing';
  for (const file of codebuddyCredentialPaths(home, provider)) {
    const candidate = readCodebuddyCredentialFile(fs, file, provider, now);
    if (!candidate.ok) { if (candidate.reason !== 'credential_file_missing') reason = candidate.reason; continue; }
    if (expected && (!expected.ok || candidate.scope !== expected.scope)) { reason = 'credential_identity_mismatch'; continue; }
    if (!best) { best = candidate; continue; }
    // Primary app identity wins over an unrelated standalone login. No merging
    // of users or distinct issuers just because one file's mtime is later.
    if (candidate.scope !== best.scope) continue;
    const decision = compareCodebuddyCredentials(best.credential, candidate.credential, provider, now);
    if (decision.reason === 'credential_time_ambiguous') return { ok: false, reason: decision.reason };
    if (decision.adopt) best = candidate;
  }
  return best || { ok: false, reason };
}
function codebuddyProjectionPath(home, provider, hostId) {
  const allowed = new Set(codebuddyCredentialPaths(home, provider));
  const sourceId = provider.startsWith('workbuddy') ? path.basename(PRIMARY[provider].at(-1), '.info') : hostId;
  const candidate = path.join(home, ...CODEBUDDY_EXTENSION_AUTH_DIR, `${sourceId}.info`);
  return allowed.has(candidate) ? candidate : path.join(home, ...PRIMARY[provider]);
}
module.exports = { inspectCodebuddyCredential, compareCodebuddyCredentials, readCodebuddyCredentialFile,
  codebuddyCredentialPaths, selectCodebuddyCredential, codebuddyProjectionPath, PRIMARY };
