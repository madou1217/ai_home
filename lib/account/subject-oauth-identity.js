'use strict';

const { decryptZcodeCredentialRecord } = require('./zcode-credential');
const {
  consistentSubject, decodeIdentityJwt, digestSubject, hasNativeSecret,
  parseIdentityObject, readSubjectAliases, tokenSubject
} = require('./identity-subject');

const TOKEN_KEYS = ['access_token', 'accessToken', 'refresh_token', 'refreshToken'];
const CLINE_ACCESS_TOKEN_PREFIX = 'workos:';
const CLINE_USER_ID_KEYS = ['accountId', 'account_id', 'clineUserId', 'external_id', 'externalId'];
const USER_KEYS = ['user_id', 'userId', 'uid', 'sub', 'subject'];
// 家族成员名单唯一来自布局模块（本文件曾自存一份四支名单，新增成员时会静默漏掉）。
const { FAMILY_PROVIDERS: CODEBUDDY_PROVIDERS } = require('../runtime/codebuddy-family-layouts');

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tokenObservations(record) {
  return TOKEN_KEYS.filter(key => record[key]).map(key => tokenSubject(record[key]));
}

function subjectSeed(provider, subject) {
  return subject ? `oauth:${provider}:user:${digestSubject(subject)}` : '';
}

/** Device identifiers and rotating refresh grants never identify a Kimi user. */
function buildKimiIdentitySeed(credentials) {
  if (!isRecord(credentials) || !hasNativeSecret(credentials, TOKEN_KEYS)) return '';
  return subjectSeed('kimi', consistentSubject([
    readSubjectAliases(credentials, USER_KEYS), ...tokenObservations(credentials)
  ]));
}

/**
 * Preserve the documented user vector, but retire email/token fallbacks. The
 * station/product prefix remains part of identity even when grant subjects match.
 */
function buildCodebuddyIdentitySeed(provider, credentials) {
  if (!CODEBUDDY_PROVIDERS.includes(provider) || !isRecord(credentials)) return '';
  const record = ['claudeAiOauth', 'codebuddyOauth', 'codebuddy_oauth', 'oauth', 'auth']
    .map(key => credentials[key]).find(isRecord) || credentials;
  if (!hasNativeSecret(record, TOKEN_KEYS)) return '';
  return subjectSeed(provider, consistentSubject([
    readSubjectAliases(record, USER_KEYS),
    readSubjectAliases(credentials.account, ['uid', 'user_id', 'userId']),
    ...tokenObservations(record)
  ]));
}

/**
 * ZCode stores an encrypted native document. Decryption stays in its existing
 * adapter; identity uses only corroborated user IDs, never display email or a
 * digest of a session token. Conflicting embedded claims fail closed.
 */
/**
 * ZCode 的身份**只由 zcode 自己的命名空间确立**：`oauth:<region>:user_info` 与
 * `zcodejwttoken`，两者都是 zcode 的 UUID user_id。
 *
 * **刻意不含 `oauth:zai:access_token`**（2026-10-27 真机取证）：那是 Z.ai/paas 面的
 * 会话 token，它的 `user_id` 属于**另一个命名空间**——同一个用户在两边是不同的值。
 * 实测同一账号：user_info/zcodejwttoken 都是 UUID `68a8c2ed-…`，而 access_token 的
 * `user_id` 是数字 `10960790`（MeaDeo 同理：`23701694489963901` vs `206905`）。
 * 把它放进一致性比较，会让 `consistentSubject` 因「两个 subject 不一致」整体
 * fail closed，身份种子变空 → 账号被判「无法确认身份」，导出/去重时被丢弃。
 * 它本来也不是身份来源，只是会话凭据。
 */
function buildZcodeIdentitySeed(credentials) {
  const { subject, region } = buildZcodeIdentitySubject(credentials);
  if (!subject) return '';
  return subjectSeed('zcode', region ? `${region}|${subject}` : subject);
}

/**
 * zcode 的**旧口径**身份种子（不含区域）。
 *
 * 为什么保留：2026-10-27 之前区域不参与身份，既有账号的 `accountRef` 都是按旧口径
 * 铸出来的。改口径后这些 ref 与新口径算出来的值不同 —— 任何「按 ref 比身份」的地方
 * （投影漂移判定、DB 快照身份判定）都必须**同时接受两个口径**，否则会把所有存量账号
 * 误判成「身份被换掉」。注册路径不需要它：`findAccountRefByIdentity` 两侧都用当前规则
 * 重新派生，存量账号会被正确复用。
 */
function buildZcodeLegacyIdentitySeed(credentials) {
  const { subject } = buildZcodeIdentitySubject(credentials);
  return subjectSeed('zcode', subject);
}

/**
 * zcode 身份 = 上游 user_id 主题 + **区域**。
 *
 * 区域为什么属于身份（用户 2026-10-27 决定）：同一个用户在 `zai`（国际站）与
 * `bigmodel`（国内站）各有独立登录态、独立套餐与独立用量，**必须是两条账号记录**，
 * 互不覆盖。此前区域不参与身份，两个区的登录态会映射到同一个 `accountRef`，
 * 于是「换区登录」看起来就像「账号被换成了别人」。
 * 区域取自凭据自带的 `oauth:active_provider`；取不到时退回旧口径（不改变既有身份）。
 */
function buildZcodeIdentitySubject(credentials) {
  if (!isRecord(credentials)) return { subject: '', region: '' };
  const plain = decryptZcodeCredentialRecord(credentials);
  if (!isRecord(plain) || !hasNativeSecret(plain, ['zcodejwttoken', 'oauth:zai:access_token'])) {
    return { subject: '', region: '' };
  }
  const userInfoText = plain['oauth:zai:user_info'] || plain['oauth:bigmodel:user_info'];
  const userInfo = userInfoText ? parseIdentityObject(userInfoText) : {};
  if (!userInfo) return { subject: '', region: '' };
  const subject = consistentSubject([
    readSubjectAliases(userInfo, ['user_id', 'userId']),
    tokenSubject(plain.zcodejwttoken)
  ]);
  return { subject, region: readZcodeRegionKey(plain) };
}

// 区域键的唯一解析处（白名单化：未知值不参与身份，避免上游加字段时把身份打散）。
const ZCODE_REGION_VALUES = Object.freeze(['zai', 'bigmodel']);

function readZcodeRegionKey(plain) {
  const raw = String(plain && plain['oauth:active_provider'] || '').trim().toLowerCase();
  return ZCODE_REGION_VALUES.includes(raw) ? raw : '';
}

/**
 * Cline 的身份是 Cline 域用户 id（`usr-…`）。WorkOS access token 里的 `sub` 是另一个
 * 命名空间的 id（`user_…`），所以不能走通用的 tokenSubject；只取 `external_id` 与本地
 * 记录里的 accountId 相互印证。轮换的 refresh grant 与展示用邮箱都不参与身份。
 */
function readClineAccessTokenUserId(accessToken) {
  const raw = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!raw) return { valid: true, subject: '' };
  const token = raw.startsWith(CLINE_ACCESS_TOKEN_PREFIX)
    ? raw.slice(CLINE_ACCESS_TOKEN_PREFIX.length)
    : raw;
  const claims = decodeIdentityJwt(token);
  return claims ? readSubjectAliases(claims, ['external_id', 'externalId']) : { valid: true, subject: '' };
}

function buildClineIdentitySeed(credentials) {
  if (!isRecord(credentials) || !hasNativeSecret(credentials, TOKEN_KEYS)) return '';
  const userInfo = isRecord(credentials.metadata) && isRecord(credentials.metadata.userInfo)
    ? credentials.metadata.userInfo
    : {};
  return subjectSeed('cline', consistentSubject([
    readSubjectAliases(credentials, CLINE_USER_ID_KEYS),
    readSubjectAliases(userInfo, ['clineUserId', 'userId', 'accountId']),
    readClineAccessTokenUserId(credentials.accessToken || credentials.access_token)
  ]));
}

module.exports = {
  buildClineIdentitySeed,
  buildKimiIdentitySeed,
  buildCodebuddyIdentitySeed,
  buildZcodeIdentitySeed,
  buildZcodeLegacyIdentitySeed,
};
