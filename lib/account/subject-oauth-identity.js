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
const CODEBUDDY_PROVIDERS = Object.freeze(['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);

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
function buildZcodeIdentitySeed(credentials) {
  if (!isRecord(credentials)) return '';
  const plain = decryptZcodeCredentialRecord(credentials);
  if (!isRecord(plain) || !hasNativeSecret(plain, ['zcodejwttoken', 'oauth:zai:access_token'])) return '';
  const userInfoText = plain['oauth:zai:user_info'];
  const userInfo = userInfoText ? parseIdentityObject(userInfoText) : {};
  if (!userInfo) return '';
  return subjectSeed('zcode', consistentSubject([
    readSubjectAliases(userInfo, ['user_id', 'userId']),
    tokenSubject(plain.zcodejwttoken), tokenSubject(plain['oauth:zai:access_token'])
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
