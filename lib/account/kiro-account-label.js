'use strict';

// kiro 账号的「展示名 + 身份键」唯一推导处。
//
// 两个事实决定了这里不能用展示名判重：
//   1. 身份只由 GetUsageLimits 的 userInfo.userId（identityEvidence.subject）确立，
//      email / 套餐只是展示数据（见 kiro-identity.js）。同一个邮箱可以同时是
//      AWS Builder ID（OIDC，免费档）与 Kiro Desktop 的 Google/GitHub 社交登录
//      （Pro+ 订阅）——两个不同的 Kiro 用户、不同的身份目录、不同的额度。
//   2. 凭据里通常没有 email，旧实现给所有账号回落同一个占位名
//      'Kiro (AWS Builder ID)'，`aih ls` 按展示名判重于是把任意两个 kiro 账号都标成重复，
//      而且社交登录账号也被错误地叫成 Builder ID。

const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('./kiro-token-flavour');
const { normalizeKiroSocialProvider } = require('./kiro-auth-metadata');
const { canonicalSubject } = require('./identity-subject');

const SOCIAL_PROVIDER_LABELS = Object.freeze({ google: 'Google', github: 'GitHub' });

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 登录口径的人类可读标签：Builder ID / IAM Identity Center / Google / GitHub / Desktop。 */
function describeKiroLoginKind(nativeAuth) {
  const auth = (nativeAuth && typeof nativeAuth.auth === 'object' && nativeAuth.auth) || {};
  const { flavour } = resolveKiroTokenFlavour(nativeAuth || {});
  if (flavour === KIRO_TOKEN_FLAVOURS.DESKTOP) {
    const social = normalizeKiroSocialProvider(auth.provider || auth.authMethod || auth.auth_method);
    return SOCIAL_PROVIDER_LABELS[social] || 'Desktop';
  }
  return readString(auth.start_url || auth.startUrl) ? 'IAM Identity Center' : 'AWS Builder ID';
}

/**
 * @param {object} nativeAuth 凭据记录里的 nativeAuth
 * @returns {{accountName: string, identityKey: string}}
 *   identityKey 为空表示没有可信身份证据（调用方退回旧的展示名启发式）。
 */
function describeKiroAccount(nativeAuth) {
  const userInfo = (nativeAuth && typeof nativeAuth.userInfo === 'object' && nativeAuth.userInfo) || {};
  const evidence = (nativeAuth && typeof nativeAuth.identityEvidence === 'object' && nativeAuth.identityEvidence) || {};
  const email = readString(userInfo.email);
  const kind = describeKiroLoginKind(nativeAuth);
  const subject = canonicalSubject(evidence.subject);
  const endpoint = readString(evidence.endpoint);
  return {
    accountName: email || `Kiro (${kind})`,
    identityKey: subject ? `kiro:${endpoint}\n${subject}` : ''
  };
}

module.exports = {
  describeKiroAccount,
  describeKiroLoginKind
};
