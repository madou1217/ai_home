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
const { refreshKiroDesktopGrant } = require('./kiro-desktop-refresh');
const { KIRO_TOKEN_FLAVOURS, resolveKiroTokenFlavour } = require('./kiro-token-flavour');

/** 把刷新结果写进凭据记录（CAS），并保留「落库失败也用新 token 继续」的语义。 */
function persistRefreshedGrant(record, grant, extra, options = {}) {
  const casWrite = options.compareAndSwapAccountNativeAuth || compareAndSwapAccountNativeAuth;
  const auth = record.nativeAuth.auth;
  const next = {
    ...record.nativeAuth,
    // 口径显式落库：下次刷新不必再猜（desktop 账号没有 registration，靠猜会误判成 oidc）。
    flavor: extra.flavour,
    auth: {
      ...auth,
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      expires_at: new Date(grant.expiresAtMs).toISOString(),
      // 已有 region 不覆盖（它决定 kiroEndpoint 与身份证据），缺失时用刷新口径的 region 补上。
      region: auth.region || grant.region
    },
    ...(extra.registration ? { registration: extra.registration } : {}),
    // social 账号的 profileArn 由上游刷新响应给出，拿到就落库（GetUsageLimits 需要它）。
    ...(extra.profileArn ? { profileArn: extra.profileArn } : {})
  };
  const persisted = casWrite(options.fs, options.aiHomeDir, record.accountRef, record, next);
  return {
    record: { ...record, nativeAuth: next },
    refreshed: true,
    persisted: Boolean(persisted),
    flavour: extra.flavour
  };
}

/**
 * 保证拿到可用的 kiro access token（纯 HTTP，不依赖本地 CLI）。
 *
 * 两条口径共用同一份实现（判型在 kiro-token-flavour.js）：
 *   * oidc    —— 有 device-registration：AWS SSO OIDC CreateToken；
 *   * desktop —— 只有 refresh_token（Google/GitHub social）：Kiro Desktop refreshToken。
 *
 * @returns {{record: object, refreshed: boolean, auth?: object}|{error: string, auth?: boolean}}
 */
async function ensureFreshKiroGrant(record, options = {}) {
  const nativeAuth = record && record.nativeAuth;
  const auth = nativeAuth && nativeAuth.auth;
  if (!auth) return { error: 'credential_record_missing' };
  if (isKiroAccessTokenFresh(auth, options.now || Date.now())) return { record, refreshed: false };

  const resolveRegistration = options.resolveKiroDeviceRegistration || resolveKiroDeviceRegistration;
  const resolveFlavour = options.resolveKiroTokenFlavour || resolveKiroTokenFlavour;
  const refreshToken = String(auth.refresh_token || auth.refreshToken || '').trim();

  const decided = resolveFlavour(nativeAuth, {
    resolveKiroDeviceRegistration: resolveRegistration,
    fs: options.fs
  });

  if (decided.flavour === KIRO_TOKEN_FLAVOURS.DESKTOP) {
    const refreshDesktop = options.refreshKiroDesktopGrant || refreshKiroDesktopGrant;
    const grant = await refreshDesktop(
      { refreshToken, region: auth.region },
      { request: options.request, timeoutMs: options.timeoutMs }
    );
    return persistRefreshedGrant(record, grant,
      { flavour: KIRO_TOKEN_FLAVOURS.DESKTOP, profileArn: grant.profileArn }, options);
  }

  const resolved = resolveRegistration(nativeAuth, { fs: options.fs });
  if (resolved.error || !resolved.registration) {
    // 拿不到 device-registration（很老的导入形态）→ 让调用方切到 CLI 兜底策略。
    return { error: resolved.error || 'kiro_registration_unavailable', auth: true };
  }
  const refreshGrant = options.refreshKiroGrant || refreshKiroGrant;
  const grant = await refreshGrant(
    { refreshToken, registration: resolved.registration },
    { request: options.request, timeoutMs: options.timeoutMs }
  );
  return persistRefreshedGrant(record, grant,
    { flavour: KIRO_TOKEN_FLAVOURS.OIDC, registration: resolved.registration }, options);
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
