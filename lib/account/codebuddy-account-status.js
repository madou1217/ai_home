'use strict';

// CodeBuddy / WorkBuddy 家族 OAuth 账号的登录态摘要（账号页快速快照与 checkStatus 共用）。
//
// 家族账号不进 Node 运行时账号池（见 docs/architecture/codebuddy-family-credential-model.md），
// 账号页只能从 DB 里的原生凭据判断是否已登录。判定复用 inspectCodebuddyCredential：
// 凭据形状、签发 realm 属于本 provider、uid 与 token 主体一致；再要求 refresh token 未过期——
// 过期且无法刷新的凭据按未登录处理（与 claude 的不可恢复过期判定一致）。

const { inspectCodebuddyCredential } = require('./codebuddy-credential-source');
// 家族成员判定唯一来自布局模块（本文件曾自存一份四支名单）。
const { isCodebuddyFamilyProvider } = require('../runtime/codebuddy-family-layouts');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function maskPhone(phone) {
  const digits = text(phone);
  return /^\d{11}$/.test(digits) ? `${digits.slice(0, 3)}****${digits.slice(7)}` : '';
}

/**
 * 账号的**可信身份键**：uid（= JWT sub）优先，其次腾讯 uin。
 *
 * 昵称不是身份：两个不同的国内站账号可以都叫「MeaDeo」（真机 2026-11-01，
 * uid/uin/手机号全不同）。`aih codebuddycn ls` 的判重在没有身份键时会退回昵称启发式，
 * 于是把两个真实账号标成「Duplicate」。所以家族也要给出身份键。
 *
 * @returns {string} 为空表示凭据里没有身份证据
 */
function describeCodebuddyIdentityKey(provider, credentials) {
  const account = credentials && typeof credentials.account === 'object' ? credentials.account : {};
  const identity = text(account.uid) || text(account.uin);
  return identity ? `codebuddy:${identity}` : '';
}

/**
 * @returns {{configured: boolean, accountName: string, reason: string, identityKey: string}}
 */
function summarizeCodebuddyAuth(provider, nativeAuth, nowMs = Date.now()) {
  const credentials = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth.credentials : null;
  const inspected = inspectCodebuddyCredential(credentials, provider, nowMs);
  if (!inspected.ok) return { configured: false, accountName: '', reason: inspected.reason, identityKey: '' };
  const account = credentials.account || {};
  const accountName = text(account.nickname) || maskPhone(account.phoneNumber) || '';
  const identityKey = describeCodebuddyIdentityKey(provider, credentials);
  const refreshExpiresAt = Number(credentials.auth && credentials.auth.refreshExpiresAt) || 0;
  if (refreshExpiresAt > 0 && refreshExpiresAt <= nowMs) {
    return { configured: false, accountName, reason: 'refresh_token_expired', identityKey };
  }
  return { configured: true, accountName, reason: '', identityKey };
}

module.exports = { isCodebuddyFamilyProvider, summarizeCodebuddyAuth };
