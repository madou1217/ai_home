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
  if (!isRecord(credentials)) return '';
  const plain = decryptZcodeCredentialRecord(credentials);
  if (!isRecord(plain) || !hasNativeSecret(plain, ['zcodejwttoken', 'oauth:zai:access_token'])) return '';
  const userInfoText = plain['oauth:zai:user_info'];
  const userInfo = userInfoText ? parseIdentityObject(userInfoText) : {};
  if (!userInfo) return '';
  return subjectSeed('zcode', consistentSubject([
    readSubjectAliases(userInfo, ['user_id', 'userId']),
    tokenSubject(plain.zcodejwttoken)
  ]));
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
  buildZcodeIdentitySeed
};
