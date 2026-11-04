'use strict';

// CodeBuddy / WorkBuddy 家族 OAuth 账号的登录态摘要（账号页快速快照与 checkStatus 共用）。
//
// 家族账号不进 Node 运行时账号池（见 docs/architecture/codebuddy-family-credential-model.md），
// 账号页只能从 DB 里的原生凭据判断是否已登录。判定复用 inspectCodebuddyCredential：
// 凭据形状、签发 realm 属于本 provider、uid 与 token 主体一致；再要求 refresh token 未过期——
// 过期且无法刷新的凭据按未登录处理（与 claude 的不可恢复过期判定一致）。

const { inspectCodebuddyCredential, readCodebuddyTokenIdentity } = require('./codebuddy-credential-source');
// 家族成员判定唯一来自布局模块（本文件曾自存一份四支名单）。
const { isCodebuddyFamilyProvider } = require('../runtime/codebuddy-family-layouts');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function maskPhone(phone) {
  const value = text(phone);
  // 上游本身就可能给打码手机号（185****5206）：原样展示，不能再剥一次。
  if (/^\d{3}\*{4}\d{4}$/.test(value)) return value;
  return /^\d{11}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(7)}` : '';
}

function normalizeEmail(value) {
  const email = text(value).toLowerCase();
  return email.includes('@') ? email : '';
}

// 中国手机号可能带 +86 / 空格 / 短横线；统一成纯数字，13 位且以 86 开头时去掉国家码。
// 上游也可能给**已打码**的 11 位号码（185****5206）：必须保留 `****`，不能把中间的
// 星号当成非数字剥掉 —— 否则会变成「前三位 + 后四位」的 1855206，既不是完整号码也
// 不是合法掩码。其它形状不做猜测（国际站的 preferred_username 是邮箱）。
function normalizePhone(value) {
  const raw = text(value).replace(/[\s-]/g, '');
  if (!raw) return '';
  if (raw.includes('*')) {
    const local = raw.replace(/^\+?86/, '');
    const masked = /^(\d{3})\*+(\d{4})$/.exec(local);
    return masked ? `${masked[1]}****${masked[2]}` : '';
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  const local = digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits;
  return /^\d{6,15}$/.test(local) ? local : '';
}

function phoneFromPreferredUsername(value) {
  const raw = text(value);
  if (/^\d{3}\*{4}\d{4}$/.test(raw)) return raw;
  return /^\+?\d[\d\s-]{5,}$/.test(raw) ? normalizePhone(raw) : '';
}

/**
 * 账号页可展示的身份事实（昵称 / 手机号 / 邮箱 / uin）。
 *
 * 取数优先级：
 *   * 昵称：凭据 account.nickname → JWT nickname；
 *   * 手机号：凭据 account.phoneNumber（国内站完整 11 位）→ JWT preferred_username
 *     （仅当它看起来是号码；国际站这里是邮箱，不能当手机号）；
 *   * 邮箱：JWT email → 凭据 account.email（部分账号对象带 email）。
 *
 * 加密凭据里的 phoneNumber 也是 sym-v1 信封，由 decodeWorkbuddyCredential 解成明文
 * （见 workbuddy-credential-codec 的 ACCOUNT_ENCRYPTED_FIELDS）；这里只消费明文。
 */
function describeCodebuddyAccountIdentity(credentials) {
  const account = credentials && typeof credentials.account === 'object' ? credentials.account : {};
  const token = readCodebuddyTokenIdentity(credentials);
  return {
    nickname: text(account.nickname) || token.nickname,
    phone: normalizePhone(account.phoneNumber) || phoneFromPreferredUsername(token.preferredUsername),
    email: normalizeEmail(token.email) || normalizeEmail(account.email),
    uin: text(account.uin),
    uid: text(account.uid)
  };
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
 * @returns {{configured: boolean, accountName: string, reason: string, identityKey: string,
 *   nickname: string, phone: string, email: string, uin: string}}
 */
function summarizeCodebuddyAuth(provider, nativeAuth, nowMs = Date.now()) {
  const credentials = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth.credentials : null;
  const inspected = inspectCodebuddyCredential(credentials, provider, nowMs);
  if (!inspected.ok) {
    return {
      configured: false, accountName: '', reason: inspected.reason, identityKey: '',
      nickname: '', phone: '', email: '', uin: ''
    };
  }
  const identity = describeCodebuddyAccountIdentity(credentials);
  const accountName = identity.nickname || maskPhone(identity.phone) || '';
  const identityKey = describeCodebuddyIdentityKey(provider, credentials);
  const facts = {
    nickname: identity.nickname,
    phone: identity.phone,
    email: identity.email,
    uin: identity.uin
  };
  const refreshExpiresAt = Number(credentials.auth && credentials.auth.refreshExpiresAt) || 0;
  if (refreshExpiresAt > 0 && refreshExpiresAt <= nowMs) {
    return { configured: false, accountName, reason: 'refresh_token_expired', identityKey, ...facts };
  }
  return { configured: true, accountName, reason: '', identityKey, ...facts };
}

module.exports = {
  isCodebuddyFamilyProvider,
  summarizeCodebuddyAuth,
  // 展示身份的单一取法：WebUI 账号页、CLI status 与测试都从这里取，避免各写一份字段优先级。
  describeCodebuddyAccountIdentity
};
