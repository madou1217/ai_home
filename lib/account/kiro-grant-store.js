'use strict';

// kiro grant 的**纯 API 刷新 + CAS 落库**（额度探针与模型发现共用同一份实现）。
//
// 为什么单独成模块：额度（GetUsageLimits）与模型清单（ListAvailableModels）是两个不同的采集面，
// 但「token 过期就先自己刷新」这件事只有一份正确做法 —— 重复实现迟早会出现一处刷了、另一处没刷
// 的假象（模型能列、额度却 403，或反过来）。

const {
  compareAndSwapAccountNativeAuth
} = require('../server/account-credential-store');
const { resolveKiroDeviceRegistration } = require('./kiro-device-registration');
const { refreshKiroGrant, isKiroAccessTokenFresh } = require('./kiro-token-refresh');

/**
 * 保证拿到可用的 kiro access token（纯 HTTP，不依赖本地 CLI）。
 *
 * @returns {{record: object, refreshed: boolean, auth?: object}|{error: string, auth?: boolean}}
 */
async function ensureFreshKiroGrant(record, options = {}) {
  const auth = record && record.nativeAuth && record.nativeAuth.auth;
  if (!auth) return { error: 'credential_record_missing' };
  if (isKiroAccessTokenFresh(auth, options.now || Date.now())) return { record, refreshed: false };

  const resolveRegistration = options.resolveKiroDeviceRegistration || resolveKiroDeviceRegistration;
  const refreshGrant = options.refreshKiroGrant || refreshKiroGrant;
  const casWrite = options.compareAndSwapAccountNativeAuth || compareAndSwapAccountNativeAuth;

  const resolved = resolveRegistration(record.nativeAuth, { fs: options.fs });
  if (resolved.error || !resolved.registration) {
    // 拿不到 device-registration（很老的导入形态）→ 让调用方切到 CLI 兜底策略。
    return { error: resolved.error || 'kiro_registration_unavailable', auth: true };
  }
  const grant = await refreshGrant(
    { refreshToken: auth.refresh_token || auth.refreshToken, registration: resolved.registration },
    { request: options.request, timeoutMs: options.timeoutMs }
  );
  const next = {
    ...record.nativeAuth,
    auth: {
      ...auth,
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      expires_at: new Date(grant.expiresAtMs).toISOString()
    },
    // 把 registration 显式存下来：下次刷新不必再解内嵌 sqlite。
    registration: resolved.registration
  };
  // CAS：CLI 同时刷新或用户重登时不覆盖别人的 grant，也不谎报成功。
  // 注意：**落库失败也要用新 token 继续**（刷新本身成功了），persisted 只用于可观察性；
  // 调用方拿到的 record 始终带新 grant，否则会拿过期 token 去探测，等于白刷一次。
  const persisted = casWrite(options.fs, options.aiHomeDir, record.accountRef, record, next);
  return {
    record: { ...record, nativeAuth: next },
    refreshed: true,
    persisted: Boolean(persisted)
  };
}

/** 刷新后 identityEvidence 的 tokenBinding 变了：把新 evidence 连同新 grant 一起落库。 */
function persistKiroIdentityEvidence(record, evidence, options = {}) {
  const current = record && record.nativeAuth;
  if (!current || !evidence) return { persisted: false };
  if (current.identityEvidence && current.identityEvidence.tokenBinding === evidence.tokenBinding) {
    return { persisted: false, unchanged: true };
  }
  const casWrite = options.compareAndSwapAccountNativeAuth || compareAndSwapAccountNativeAuth;
  const persisted = casWrite(options.fs, options.aiHomeDir, record.accountRef, record,
    { ...current, identityEvidence: evidence });
  return { persisted: Boolean(persisted) };
}

module.exports = {
  ensureFreshKiroGrant,
  persistKiroIdentityEvidence
};
