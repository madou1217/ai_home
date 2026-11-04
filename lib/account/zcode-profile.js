'use strict';

// zcode 身份补全：BigModel 的 `user_info` 只有 id/username/displayName/rawProfile，
// 经常缺手机号（甚至邮箱）。BigModel 客户信息接口 `/api/biz/customer/getCustomerInfo`
// 用同一枚区域 access_token 能取到 phoneNumber / email / customerName，正好补上。
//
// 纪律：
//   * 只在 bigmodel 区域调用（zai 的 user_info 已经带邮箱/手机号，且接口不同）；
//   * **异步补全**，不在账号列表首帧的同步路径里发网络请求；
//   * 结果合并回 `oauth:<region>:user_info` 并 CAS 写库，下一次构建账号记录就是快的；
//   * 失败静默（10 分钟内不重试），不能影响用量/账号列表主流程；
//   * 加密的 user_info 原样加密写回，不把明文身份落到 DB。

const {
  compareAndSwapAccountNativeAuth: defaultCompareAndSwapAccountNativeAuth,
  readAccountCredentialRecord: defaultReadAccountCredentialRecord
} = require('../server/account-credential-store');
const {
  encryptZcodeCredentialValue,
  isEncryptedZcodeCredentialValue,
  readZcodeOAuthCredential
} = require('./zcode-credential');
const { isMaskedEmail, normalizePhone } = require('./zcode-identity');

const BIGMODEL_CUSTOMER_INFO_URL = 'https://bigmodel.cn/api/biz/customer/getCustomerInfo';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 6000;

// 失败节流是进程内的：成功会写 zcodeProfileFetchedAt，重启后仍生效；
// 失败不落库（避免把「上游暂时不可用」写成永久事实），只在这里记 10 分钟。
const failureAt = new Map();

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  const email = text(value).toLowerCase();
  return email.includes('@') ? email : '';
}

function zcodeProfileFetchedAt(userInfo) {
  const raw = userInfo && typeof userInfo === 'object' ? userInfo.rawProfile : null;
  return Number(raw && raw.zcodeProfileFetchedAt) || 0;
}

function shouldRefreshZcodeProfile(userInfo, nowMs, ttlMs = DEFAULT_TTL_MS) {
  const at = zcodeProfileFetchedAt(userInfo);
  return !(at > 0 && Number(nowMs) - at < Math.max(0, Number(ttlMs) || 0));
}

/**
 * 把客户信息合并进 user_info（不覆盖已有的更具体事实）。
 *
 * @param {object} userInfo 现有 user_info（两种区域结构都接受）
 * @param {object} customer getCustomerInfo 的 data
 * @param {number} nowMs 本次拉取时刻（写入 rawProfile.zcodeProfileFetchedAt）
 * @returns {object} 新的 user_info
 */
function mergeZcodeCustomerInfo(userInfo, customer, nowMs = Date.now()) {
  const base = userInfo && typeof userInfo === 'object' && !Array.isArray(userInfo) ? userInfo : {};
  const raw = base.rawProfile && typeof base.rawProfile === 'object' && !Array.isArray(base.rawProfile)
    ? base.rawProfile
    : {};
  const nextRaw = { ...raw };
  const source = customer && typeof customer === 'object' ? customer : {};
  const phone = normalizePhone(source.phoneNumber);
  const apiEmail = normalizeEmail(source.email);
  const name = text(source.nickName) || text(source.customerName);
  const customerId = text(source.customerNumber) || text(source.id);
  const avatar = text(source.avatar) || text(source.avatarUrl);

  if (phone) nextRaw.phoneNumber = phone;
  const currentEmail = normalizeEmail(raw.email);
  // 已有完整邮箱不降级成上游打码邮箱；空值/打码值可以被完整邮箱替换。
  if (apiEmail && (!currentEmail || (!isMaskedEmail(apiEmail) && isMaskedEmail(currentEmail)))) {
    nextRaw.email = apiEmail;
  }
  if (name && !text(raw.name)) nextRaw.name = name;
  if (customerId && !text(raw.user_id)) nextRaw.user_id = customerId;
  if (avatar && !text(raw.avatar)) nextRaw.avatar = avatar;
  nextRaw.zcodeProfileFetchedAt = nowMs;

  const next = { ...base, rawProfile: nextRaw };
  if (customerId && !text(next.id) && !text(next.user_id)) next.id = customerId;
  // 顶层展示名只在完全缺失时补；已有 username/displayName 不覆盖。
  if (name && !text(next.displayName) && !text(next.username) && !text(next.name)) {
    next.displayName = name;
    next.username = name;
  }
  return next;
}

async function fetchBigModelCustomerInfo(accessToken, options = {}) {
  const token = text(accessToken);
  if (!token) return { ok: false, error: 'missing_access_token' };
  const request = typeof options.request === 'function'
    ? options.request
    : (url, init) => fetch(url, init);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await request(BIGMODEL_CUSTOMER_INFO_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'user-agent': text(options.userAgent) || 'ZCode/2.0'
      },
      ...(controller ? { signal: controller.signal } : {})
    }, timeoutMs);
    if (!response || typeof response.json !== 'function') return { ok: false, error: 'invalid_response' };
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || body.success === false || !body.data || typeof body.data !== 'object') {
      return { ok: false, error: 'business_error' };
    }
    const code = Number(body.code);
    if (Number.isFinite(code) && code !== 0 && code !== 200) return { ok: false, error: `code_${code}` };
    return { ok: true, customer: body.data };
  } catch (error) {
    return { ok: false, error: error && error.name === 'AbortError' ? 'timeout' : 'request_failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把补全后的 user_info 写回凭据；原值是加密信封时继续加密，保持落盘形态不变。 */
function applyZcodeCustomerInfoToCredentials(credentials, region, userInfo, options = {}) {
  const key = `oauth:${region}:user_info`;
  const current = credentials && typeof credentials === 'object' ? credentials : {};
  const json = JSON.stringify(userInfo);
  const value = isEncryptedZcodeCredentialValue(current[key])
    ? encryptZcodeCredentialValue(json, options)
    : json;
  return { ...current, [key]: value };
}

function failureFresh(key, nowMs, ttlMs) {
  const at = failureAt.get(key) || 0;
  return at > 0 && Number(nowMs) - at < Math.max(0, Number(ttlMs) || 0);
}

/**
 * 补全一个 zcode 账号的身份（当前只对 bigmodel 生效）。
 *
 * @param {object} options
 *   fs / aiHomeDir / accountRef / record（可省，省了按 accountRef 读）
 *   request（可注入，默认 fetch；服务器传 http-utils 的 fetchWithTimeout）
 *   cas（可注入 CAS，默认 account-credential-store 的实现）
 *   nowMs / ttlMs / timeoutMs / failureTtlMs / osImpl / env
 * @returns {Promise<{updated?: boolean, skipped?: boolean, reason: string}>}
 */
async function refreshZcodeAccountIdentity(options = {}) {
  const { fs, aiHomeDir, accountRef } = options;
  const nowMs = Number(options.nowMs) || Date.now();
  // 0 是合法值（强制刷新/立即可重试），不能被 `|| default` 吞掉。
  const ttlMs = options.ttlMs === undefined || options.ttlMs === null
    ? DEFAULT_TTL_MS
    : Math.max(0, Number(options.ttlMs) || 0);
  const failureTtlMs = options.failureTtlMs === undefined || options.failureTtlMs === null
    ? DEFAULT_FAILURE_TTL_MS
    : Math.max(0, Number(options.failureTtlMs) || 0);
  const readRecord = typeof options.readAccountCredentialRecord === 'function'
    ? options.readAccountCredentialRecord
    : defaultReadAccountCredentialRecord;
  let record = options.record || null;
  if (!record && fs && aiHomeDir && accountRef) {
    try { record = readRecord(fs, aiHomeDir, accountRef); } catch (_error) { record = null; }
  }
  if (!record || String(record.provider || '').trim().toLowerCase() !== 'zcode') {
    return { skipped: true, reason: 'credential_record_missing' };
  }
  const nativeAuth = record.nativeAuth && typeof record.nativeAuth === 'object' ? record.nativeAuth : {};
  const oauth = readZcodeOAuthCredential(nativeAuth, options);
  const region = text(oauth.activeProvider).toLowerCase();
  if (region !== 'bigmodel') return { skipped: true, reason: 'not_bigmodel' };
  const accessToken = text(oauth.accessToken);
  if (!accessToken) return { skipped: true, reason: 'missing_access_token' };
  if (!shouldRefreshZcodeProfile(oauth.userInfo, nowMs, ttlMs)) return { skipped: true, reason: 'fresh' };

  const failureKey = `${accountRef || record.accountRef || ''}:bigmodel`;
  if (failureFresh(failureKey, nowMs, failureTtlMs)) return { skipped: true, reason: 'recent_failure' };

  const fetched = await fetchBigModelCustomerInfo(accessToken, options);
  if (!fetched.ok) {
    failureAt.set(failureKey, nowMs);
    return { skipped: true, reason: fetched.error || 'fetch_failed', failed: true };
  }
  failureAt.delete(failureKey);

  const nextUserInfo = mergeZcodeCustomerInfo(oauth.userInfo, fetched.customer, nowMs);
  const nextCredentials = applyZcodeCustomerInfoToCredentials(
    nativeAuth.credentials && typeof nativeAuth.credentials === 'object' ? nativeAuth.credentials : {},
    region,
    nextUserInfo,
    options
  );
  const nextNativeAuth = { ...nativeAuth, credentials: nextCredentials };
  const cas = typeof options.cas === 'function' ? options.cas : defaultCompareAndSwapAccountNativeAuth;
  let saved = false;
  try { saved = Boolean(cas(fs, aiHomeDir, accountRef, record, nextNativeAuth)); } catch (_error) { saved = false; }
  return {
    updated: saved,
    reason: saved ? 'profile_merged' : 'concurrent_update',
    userInfo: nextUserInfo
  };
}

module.exports = {
  BIGMODEL_CUSTOMER_INFO_URL,
  DEFAULT_TTL_MS,
  DEFAULT_FAILURE_TTL_MS,
  applyZcodeCustomerInfoToCredentials,
  fetchBigModelCustomerInfo,
  mergeZcodeCustomerInfo,
  refreshZcodeAccountIdentity,
  shouldRefreshZcodeProfile,
  zcodeProfileFetchedAt
};
