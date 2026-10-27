'use strict';

// **zcode 账号投影里的「登录身份漂移」判定**（唯一实现处）。
//
// 事实：zcode 的桌面端在**账号沙箱**里登录时（WebUI 打开 Desktop → 登录），会把
// `oauth:<region>:*` / `zcodejwttoken` 写进**该账号的投影**
// （`run/auth-projections/zcode/<accountRef>/.zcode/v2/credentials.json`）。
// 真机（2026-10-27）：用户在那个沙箱里登成了**另一个身份**（126 → gmail），于是投影
// 里不再是这个账号的身份，而 aih 当时把它当成同一账号采用（DB 快照也被覆盖成 gmail），
// 结果两个上游身份共用一条账号记录（额度/用量历史、套餐归属全部混在一起）。
//
// 判据是**权威的、不需要另存一份种子**：`accountRef` 本身就是身份种子派生的
// （见 account-registration 的 `getPublicAccountRef('unique:' + identitySeed)`），
// 所以「投影身份的 canonical ref ≠ 该账号的 ref」就是漂移；两者相等就是同身份。
//
// 本模块只做判定与读取，**不写任何东西**（注册/搬迁/清理在 zcode-projection-identity-sync）。

const nodePath = require('node:path');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { readZcodeOAuthCredential } = require('./zcode-credential');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { resolveZcodeAccountIdentity } = require('./zcode-identity');

// 投影里**承载登录身份**的文件：漂移发生时它们跟着身份走（搬迁清单的唯一事实源）。
const ZCODE_PROJECTION_IDENTITY_FILES = Object.freeze([
  'credentials.json',
  'onboarding-record.json',
  'telemetry-state.json',
  'setting.json'
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 该账号投影的 `.zcode/v2` 目录（不存在时返回空串）。 */
function resolveZcodeProjectionDir(aiHomeDir, accountRef) {
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'zcode', accountRef);
  if (!runtimeDir) return '';
  return nodePath.join(runtimeDir, '.zcode', 'v2');
}

/** 读投影里的凭据文档（缺失/损坏 → null）。 */
function readZcodeProjectionCredentials(fs, aiHomeDir, accountRef) {
  const dir = resolveZcodeProjectionDir(aiHomeDir, accountRef);
  if (!dir || !fs || typeof fs.readFileSync !== 'function') return null;
  try {
    const parsed = JSON.parse(String(fs.readFileSync(nodePath.join(dir, 'credentials.json'), 'utf8') || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 解析投影当前承载的登录身份。
 *
 * @returns {{
 *   present: boolean,           投影里有没有凭据
 *   degraded: boolean,          身份种子取不出来（缺 user_info / 凭据不完整）
 *   identitySeed: string,
 *   canonicalAccountRef: string,该身份**应该**属于哪个 accountRef
 *   email: string, displayName: string,
 *   credentials: object|null
 * }}
 */
function resolveZcodeProjectionIdentity(options = {}) {
  const fs = options.fs;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const accountRef = normalizeText(options.accountRef);
  const credentials = readZcodeProjectionCredentials(fs, aiHomeDir, accountRef);
  if (!credentials) {
    return { present: false, degraded: false, identitySeed: '', canonicalAccountRef: '', email: '', displayName: '', credentials: null };
  }
  let identity = { identitySeed: '', degraded: true };
  try {
    identity = resolveNativeAuthIdentitySeed('zcode', { credentials });
  } catch (_error) {
    identity = { identitySeed: '', degraded: true };
  }
  const seed = normalizeText(identity && identity.identitySeed);
  if (!seed || (identity && identity.degraded)) {
    return { present: true, degraded: true, identitySeed: '', canonicalAccountRef: '', email: '', displayName: '', credentials };
  }
  // 只在判定需要 ref 时才 require：account-ref 会打开 app-state 库（叶子依赖，避免初始化期拉库）。
  const { getPublicAccountRef } = require('../server/account-ref-store');
  const oauth = readZcodeOAuthCredential({ credentials });
  const label = resolveZcodeAccountIdentity(oauth.userInfo);
  return {
    present: true,
    degraded: false,
    identitySeed: seed,
    canonicalAccountRef: getPublicAccountRef(`unique:${seed}`),
    email: normalizeText(label && label.email),
    displayName: normalizeText(label && label.displayName),
    credentials
  };
}

/**
 * 解析**账号 DB 快照**当前承载的登录身份（与投影判定同源，用于决定「要不要清凭据」）。
 *
 * 为什么需要：投影里出现外来登录态有两种完全不同的情况 ——
 *   a) 该账号的凭据**也**已被换成那个外来身份（DB 快照 = 外来身份）→ 这才是「账号被换成别人」，
 *      应清掉 DB 里的外来凭据，账号回到「需重新登录」；
 *   b) DB 快照仍是**它自己**的身份，只是有人往它的沙箱里登过另一个身份（投影被占用）→
 *      它自己的凭据必须保留，只把投影里的外来登录态搬走。
 * 真机教训（2026-10-27）：第一版实现只看投影，于是把 (b) 的账号自己的凭据也清了 —— 那是破坏性的。
 */
function resolveZcodeNativeAuthIdentity(options = {}) {
  const fs = options.fs;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const accountRef = normalizeText(options.accountRef);
  if (!fs || !aiHomeDir || !accountRef) return { present: false, canonicalAccountRef: '', identitySeed: '' };
  let auth = null;
  try {
    auth = require('../server/account-credential-store').readAccountNativeAuth(fs, aiHomeDir, accountRef);
  } catch (_error) {
    return { present: false, canonicalAccountRef: '', identitySeed: '' };
  }
  if (!auth || typeof auth !== 'object' || !auth.credentials || typeof auth.credentials !== 'object') {
    return { present: false, canonicalAccountRef: '', identitySeed: '' };
  }
  let identity = { identitySeed: '', degraded: true };
  try {
    identity = resolveNativeAuthIdentitySeed('zcode', auth);
  } catch (_error) {
    identity = { identitySeed: '', degraded: true };
  }
  const seed = normalizeText(identity && identity.identitySeed);
  if (!seed || (identity && identity.degraded)) return { present: true, canonicalAccountRef: '', identitySeed: '' };
  const { getPublicAccountRef } = require('../server/account-ref-store');
  return { present: true, canonicalAccountRef: getPublicAccountRef(`unique:${seed}`), identitySeed: seed };
}

/**
 * 该账号的投影是否已被**另一个身份**占用。
 *
 * @returns {{drifted: boolean, reason: string, projection: object}}
 *   reason: 'no_projection' | 'identity_degraded' | 'match' | 'replaced_by_other_identity'
 */
function detectZcodeProjectionIdentityDrift(options = {}) {
  const accountRef = normalizeText(options.accountRef);
  const projection = resolveZcodeProjectionIdentity(options);
  if (!projection.present) return { drifted: false, reason: 'no_projection', projection };
  if (projection.degraded) return { drifted: false, reason: 'identity_degraded', projection };
  if (!accountRef || projection.canonicalAccountRef === accountRef) {
    return { drifted: false, reason: 'match', projection };
  }
  return { drifted: true, reason: 'replaced_by_other_identity', projection };
}

module.exports = {
  ZCODE_PROJECTION_IDENTITY_FILES,
  resolveZcodeProjectionDir,
  readZcodeProjectionCredentials,
  resolveZcodeProjectionIdentity,
  resolveZcodeNativeAuthIdentity,
  detectZcodeProjectionIdentityDrift
};
