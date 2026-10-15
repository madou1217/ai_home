'use strict';

// kiro 的**纯 HTTP** 令牌刷新 —— 不依赖本地 CLI / 桌面 App。
//
// 实测（2026-10-15，AWS SSO OIDC CreateToken）：
//   POST https://oidc.<region>.amazonaws.com/token
//   { "clientId": <device-registration.client_id>,
//     "clientSecret": <device-registration.client_secret>,
//     "grantType": "refresh_token",
//     "refreshToken": <token.refresh_token> }
//   → 200 { accessToken, expiresIn, refreshToken }   （refresh_token 未轮换，可重复使用）
//
// 这一步是 kiro 采集的关键：**access token 过期后 GetUsageLimits 返回 403**（AWS 对过期 SSO
// token 用 403 而不是 401），我们的错误映射把它记成 `kiro_identity_access_denied`，
// 看起来像权限问题，实际只是没刷新。以前唯一的刷新来源是「从本地 CLI 的 sqlite 里抄」，
// 因此没装 CLI 就永远 403。本模块把刷新变成纯 API 调用。

const TIMEOUT_MS = 10000;

const { KIRO_TOKEN_FLAVOURS, resolveKiroTokenFlavour } = require('./kiro-token-flavour');
const { refreshKiroDesktopGrant } = require('./kiro-desktop-refresh');
const { resolveKiroDeviceRegistration } = require('./kiro-device-registration');

function refreshError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveOidcEndpoint(region) {
  const normalized = /^[a-z]{2}-[a-z]+-\d$/.test(String(region || '')) ? String(region) : 'us-east-1';
  return `https://oidc.${normalized}.amazonaws.com/token`;
}

/**
 * 用 refresh_token 换新的 access_token（纯 HTTP）。
 *
 * @param {{refreshToken: string, registration: {clientId: string, clientSecret: string, region?: string}}} input
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAtMs: number, region: string}|never>}
 */
async function refreshKiroGrant(input, options = {}) {
  const refreshToken = String(input && input.refreshToken || '').trim();
  const registration = input && input.registration;
  const clientId = String(registration && registration.clientId || '').trim();
  const clientSecret = String(registration && registration.clientSecret || '').trim();
  if (!refreshToken) throw refreshError('kiro_refresh_missing_refresh_token');
  if (!clientId || !clientSecret) throw refreshError('kiro_refresh_missing_client_registration');

  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw refreshError('kiro_refresh_transport_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(resolveOidcEndpoint(registration.region), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        grantType: 'refresh_token',
        refreshToken
      }),
      redirect: 'error',
      signal: controller.signal
    });
    if (!response || response.status !== 200) {
      throw refreshError(`kiro_refresh_http_${response && response.status ? response.status : 'failed'}`);
    }
    const document = await response.json().catch(() => null);
    const accessToken = String(document && document.accessToken || '').trim();
    if (!accessToken) throw refreshError('kiro_refresh_missing_access_token');
    const expiresInSeconds = Number(document && document.expiresIn);
    return {
      accessToken,
      // AWS 只在轮换时才返回新的 refresh_token；没轮换就沿用旧的（实测不轮换）。
      refreshToken: String(document && document.refreshToken || '').trim() || refreshToken,
      expiresAtMs: Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? expiresInSeconds * 1000
        : 3600 * 1000),
      region: String(registration.region || 'us-east-1')
    };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('kiro_refresh_')) throw error;
    throw refreshError(controller.signal.aborted ? 'kiro_refresh_timeout' : 'kiro_refresh_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}

/** 当前 access_token 是否仍然可用（带 60s 余量，避免边界上刚好过期）。 */
function isKiroAccessTokenFresh(auth, nowMs = Date.now(), skewMs = 60000) {
  const expiresAt = Date.parse(String(auth && auth.expires_at || ''));
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - skewMs > nowMs;
}

/**
 * 按凭据口径刷新 grant —— **刷新入口只有这一个**（判型见 kiro-token-flavour.js）。
 *
 * @param {{nativeAuth?: object, refreshToken?: string, registration?: object, region?: string}} input
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAtMs: number, region: string, profileArn: string, flavour: string}>}
 */
async function refreshKiroToken(input, options = {}) {
  const refreshToken = String(input && input.refreshToken || '').trim();
  const decided = options.flavour
    ? { flavour: options.flavour }
    : resolveKiroTokenFlavour(input && input.nativeAuth, options);

  if (decided.flavour === KIRO_TOKEN_FLAVOURS.DESKTOP) {
    const grant = await refreshKiroDesktopGrant(
      { refreshToken, region: input && input.region },
      { request: options.request, timeoutMs: options.timeoutMs }
    );
    return { ...grant, flavour: KIRO_TOKEN_FLAVOURS.DESKTOP };
  }
  const resolvedRegistration = input && input.registration
    ? { registration: input.registration }
    : (options.resolveKiroDeviceRegistration || resolveKiroDeviceRegistration)(input && input.nativeAuth, options);
  const grant = await refreshKiroGrant(
    { refreshToken, registration: resolvedRegistration && resolvedRegistration.registration },
    { request: options.request, timeoutMs: options.timeoutMs }
  );
  return { ...grant, profileArn: '', flavour: KIRO_TOKEN_FLAVOURS.OIDC };
}

module.exports = {
  resolveOidcEndpoint,
  refreshKiroGrant,
  refreshKiroToken,
  isKiroAccessTokenFresh
};
