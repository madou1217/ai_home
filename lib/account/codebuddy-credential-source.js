'use strict';

// Local .info routing evidence, not JWT signature verification. The upstream
// still authenticates the token. Only fixed, observed issuer origins are used.
const path = require('node:path');
const crypto = require('node:crypto');
const { readCodebuddyDesktopCredential } = require('./codebuddy-desktop-credential');
const { decodeWorkbuddyCredential } = require('./workbuddy-credential-codec');
const { CODEBUDDY_CN_SHARED_AUTH_PATH,
  CODEBUDDY_AI_SHARED_AUTH_PATH, CODEBUDDY_INTL_SHARED_AUTH_PATH } = require('../runtime/provider-storage-policy');
const { AUTH_FILE_NAMES: CODEBUDDY_FAMILY_AUTH_FILE_NAMES,
  familyAuthPaths, familyProjectionAuthPath } = require('../runtime/codebuddy-family-layouts');
// darwin 下的 HOME 相对路径，仅用于兼容既有调用方（`host-sync` 拿它做家族成员判定、
// 这里拿它派生 hostId）。**路径解析一律走 codebuddy-family-layouts.js**。
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
function readCodebuddyCredentialFile(fs, file, provider = '', nowMs = Date.now(), options = {}) {
  try {
    const a = fs.lstatSync(file);
    if (!a.isFile() || a.isSymbolicLink() || a.size > MAX_BYTES) return { ok: false, reason: 'unsupported_credential_file' };
    const raw = fs.readFileSync(file, 'utf8'), b = fs.lstatSync(file);
    if (['ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => a[key] !== b[key])) return { ok: false, reason: 'credential_file_changed' };
    if (Buffer.byteLength(raw) > MAX_BYTES) return { ok: false, reason: 'credential_file_too_large' };
    const rawCredential = JSON.parse(raw);
    let decoded;
    // 解密要知道用哪支发行版的运行时（WorkBuddy 的 .info 是加密信封），但**归属**仍然只由
    // issuer（realm）判定 —— 调用方可以只给 `decodeProvider`，不给 `provider`。
    const decodeProvider = options.decodeProvider || provider;
    try { decoded = decodeWorkbuddyCredential(rawCredential, decodeProvider, { ...options, fs }); }
    catch (_) { return { ok: false, reason: 'encrypted_credential_unavailable' }; }
    const credential = decoded.credential, inspection = inspectCodebuddyCredential(credential, provider, nowMs);
    return inspection.ok ? { ...inspection, credential, encrypted: decoded.encrypted,
      ...(decoded.encrypted ? { rawCredential } : {}), hostId: path.basename(file, '.info') } : inspection;
  } catch (error) { return { ok: false, reason: error.code === 'ENOENT' ? 'credential_file_missing' : 'credential_file_unreadable' }; }
}
// 有序候选凭据文件：首选项是本 Provider 自己的文件，国内站两支额外把国际站文件
// 作为次选（见 codebuddy-family-layouts 的 CROSS_SITE_FALLBACK）。路径随平台变化，
// 默认取当前平台；调用方可显式传 `{ platform }` 做跨平台解析或测试。
function codebuddyCredentialPaths(home, provider, options = {}) {
  return familyAuthPaths(home, provider, options);
}
function readCodebuddyDesktopCredentialSource(fs, home, provider, options = {}) {
  const credential = readCodebuddyDesktopCredential(fs, home, provider, options);
  if (!credential) return { ok: false, reason: 'desktop_credential_unavailable' };
  const inspection = inspectCodebuddyCredential(credential, provider, options.nowMs);
  const fileName = CODEBUDDY_FAMILY_AUTH_FILE_NAMES[String(provider || '').trim().toLowerCase()] || '';
  const hostId = fileName ? path.basename(fileName, '.info') : path.basename(String(credential.hostId || ''), '.info');
  return inspection.ok ? { ...inspection, credential, hostId } : inspection;
}
function selectCodebuddyCredential(fs, home, provider, options = {}) {
  const now = options.nowMs || Date.now(), expected = options.expected && inspectCodebuddyCredential(options.expected, provider, now);
  let best = null, reason = 'credential_file_missing';
  const candidates = codebuddyCredentialPaths(home, provider, options).map(file => readCodebuddyCredentialFile(fs, file, provider, now, options));
  const desktop = readCodebuddyDesktopCredentialSource(fs, home, provider, options);
  if (desktop.ok) candidates.push(desktop);
  for (const candidate of candidates) {
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
// 凭据**真正归属**哪支家族 Provider：只由 token 的 realm（iss）判定。
//
// `@tencent-ai/codebuddy-code` 国内站与国际站是同一个二进制，首启让用户选
// 「国内站 / 国际站 / 企业域名」，所以「用户敲的是 aih codebuddy 还是
// aih codebuddycn」决定不了这次登录落在哪个站点 —— 只有签出来的 token 知道。
// 2026-10-31 真机：`aih codebuddy login` 选国内站，OAuth 成功后 .info 里是一枚
// realm=copilot.tencent.com 的 token，按 codebuddy（国际站）校验即
// credential_realm_mismatch，登录被报成笼统的 missing_projection。
//
// 候选文件按「本 Provider 优先」排序（见 familyAuthPaths）：只要有一枚属于本
// Provider 就取它，否则取最新签发的那枚并回报它的归属，由调用方决定是否改档。
function resolveCodebuddyCredentialOwner(fs, home, provider, options = {}) {
  const now = options.nowMs || Date.now();
  const files = codebuddyCredentialPaths(home, provider, options);
  let reason = 'credential_file_missing';
  let preferred = null, newest = null;
  for (const file of files) {
    // provider 传空串：只做家族通用的形状/realm 校验，归属交给 issuer 决定。
    const candidate = readCodebuddyCredentialFile(fs, file, '', now, { ...options, decodeProvider: provider });
    if (!candidate.ok) {
      if (candidate.reason !== 'credential_file_missing') reason = candidate.reason;
      continue;
    }
    const owners = Array.isArray(candidate.providers) ? candidate.providers : [];
    const owner = owners.includes(provider) ? provider : owners[0];
    if (!owner) { reason = 'unrecognized_credential_realm'; continue; }
    const resolved = { ...candidate, ok: true, provider: owner };
    if (!newest || resolved.issuedAt > newest.issuedAt) newest = resolved;
    if (owner === provider && (!preferred || resolved.issuedAt > preferred.issuedAt)) preferred = resolved;
  }
  return preferred || newest || { ok: false, reason };
}

// 沙箱投影该写哪个文件：WorkBuddy 两支固定写自己的文件（host id 与独立 CLI 不同，
// 不能借用 CLI 的 hostId），其余按 hostId 定位，落在候选集合外时回退到主候选。
function codebuddyProjectionPath(home, provider, hostId, options = {}) {
  return familyProjectionAuthPath(home, provider, hostId, options);
}
module.exports = { inspectCodebuddyCredential, compareCodebuddyCredentials, readCodebuddyCredentialFile,
  readCodebuddyDesktopCredentialSource, codebuddyCredentialPaths, selectCodebuddyCredential,
  codebuddyProjectionPath, resolveCodebuddyCredentialOwner, PRIMARY };
