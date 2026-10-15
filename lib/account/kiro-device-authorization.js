'use strict';

// kiro 的 **设备码授权**（AWS IAM Identity Center OIDC + RFC 8628）——
// 「不装 CLI / IDE 也能把账号加进来」的入口。
//
// 三步纯 HTTP（AWS OIDC API 公开文档 + 官方开源 CLI 的同一流程，见
// aws/amazon-q-developer-cli 的 crates/chat-cli/src/auth/builder_id.rs）：
//   1) POST /client/register       {clientName, clientType:'public', scopes, grantTypes}
//                                  → clientId / clientSecret / clientSecretExpiresAt
//   2) POST /device_authorization  {clientId, clientSecret, startUrl}
//                                  → deviceCode / userCode / verificationUri(Complete) / interval / expiresIn
//   3) POST /token                 {clientId, clientSecret, grantType:<device_code>, deviceCode}
//                                  → accessToken / refreshToken / expiresIn
//      用户还没批准时返回 400 {error:'authorization_pending'}（轮询继续）；
//      另有 slow_down / expired_token / access_denied。
//
// 常量取自官方 CLI 的 auth/consts.rs：scopes 只要 completions / analysis / conversations
// （taskassist、transformations 在官方代码里已被注释掉）；public Builder ID 的 startUrl 是
// https://view.awsapps.com/start；device grant 类型是 RFC 8628 的标准 URN。
//
// 产出与 CLI 导入**完全同构**的凭据（nativeAuth.registration + nativeAuth.auth），因此
// 采集、模型清单、推理三条链路一行都不用改。

const DEFAULT_REGION = 'us-east-1';
const TIMEOUT_MS = 10000;

const KIRO_CLIENT_TYPE = 'public';
const KIRO_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const KIRO_REFRESH_GRANT = 'refresh_token';
// 官方 CLI 的 OIDC scopes（sso:account:access 被官方明确排除，我们也不请求）。
const KIRO_OIDC_SCOPES = Object.freeze([
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations'
]);
// public Builder ID 的 start URL（官方 CLI 的 START_URL 常量）。
const KIRO_BUILDER_ID_START_URL = 'https://view.awsapps.com/start';

function deviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeRegion(value) {
  const region = String(value || '').trim();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? region : DEFAULT_REGION;
}

function resolveKiroOidcEndpoint(region) {
  return `https://oidc.${normalizeRegion(region)}.amazonaws.com`;
}

/** 统一的一次性 POST JSON：所有网络/解析失败都归到 `kiro_device_*` 错误码。 */
async function postJson(path, body, options = {}) {
  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw deviceError('kiro_device_transport_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(`${resolveKiroOidcEndpoint(options.region)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal
    });
    const status = response && response.status ? response.status : 0;
    const document = await (response && typeof response.json === 'function'
      ? response.json().catch(() => null)
      : Promise.resolve(null));
    return { status, document };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('kiro_device_')) throw error;
    throw deviceError(controller.signal.aborted ? 'kiro_device_timeout' : 'kiro_device_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 第 1 步：注册一个 public 客户端（有效期数月，应当落库复用）。
 * @returns {Promise<{clientId, clientSecret, clientSecretExpiresAt, region, oauthFlow, scopes}>}
 */
async function registerKiroOidcClient(input = {}, options = {}) {
  const region = normalizeRegion(input.region);
  const scopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.map((scope) => String(scope))
    : [...KIRO_OIDC_SCOPES];
  const body = {
    clientName: String(input.clientName || 'aih').trim() || 'aih',
    clientType: KIRO_CLIENT_TYPE,
    scopes,
    grantTypes: [KIRO_DEVICE_GRANT, KIRO_REFRESH_GRANT],
    ...(String(input.issuerUrl || '').trim() ? { issuerUrl: String(input.issuerUrl).trim() } : {})
  };
  const { status, document } = await postJson('/client/register', body, { ...options, region });
  if (status !== 200) throw deviceError(`kiro_device_register_http_${status || 'failed'}`);
  const clientId = String(document && document.clientId || '').trim();
  const clientSecret = String(document && document.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw deviceError('kiro_device_register_missing_client');
  const expiresAt = Number(document && document.clientSecretExpiresAt);
  return {
    clientId,
    clientSecret,
    clientSecretExpiresAt: Number.isFinite(expiresAt) && expiresAt > 0
      ? new Date(expiresAt * 1000).toISOString()
      : '',
    region,
    oauthFlow: 'DeviceCode',
    scopes
  };
}

/**
 * 第 2 步：开始设备授权，拿到给用户看的 user code 与验证地址。
 *
 * `verificationUriComplete` 是「带上 code 的完整链接」——给用户直接点/扫码即可，
 * 因此 SSH / 远程环境下也不需要本机浏览器。
 *
 * @returns {Promise<{deviceCode, userCode, verificationUri, verificationUriComplete, intervalSeconds, expiresInSeconds}>}
 */
async function startKiroDeviceAuthorization(input = {}, options = {}) {
  const registration = input.registration || {};
  const clientId = String(registration.clientId || '').trim();
  const clientSecret = String(registration.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw deviceError('kiro_device_missing_client_registration');

  const { status, document } = await postJson('/device_authorization', {
    clientId,
    clientSecret,
    // 默认 Builder ID 的 public start URL；IAM Identity Center（企业）由调用方传自己的 portal URL。
    startUrl: String(input.startUrl || KIRO_BUILDER_ID_START_URL).trim()
  }, { ...options, region: registration.region || input.region });

  if (status !== 200) throw deviceError(`kiro_device_start_http_${status || 'failed'}`);
  const deviceCode = String(document && document.deviceCode || '').trim();
  const userCode = String(document && document.userCode || '').trim();
  const verificationUri = String(document && document.verificationUri || '').trim();
  if (!deviceCode || !userCode || !verificationUri) throw deviceError('kiro_device_start_missing_codes');
  const interval = Number(document && document.interval);
  const expiresIn = Number(document && document.expiresIn);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: String(document && document.verificationUriComplete || '').trim() || verificationUri,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600
  };
}

/**
 * 第 3 步：轮询一次 CreateToken。
 *
 * 「用户还没批准」不是错误（pending / slow_down），只有上游真出错才抛 ——
 * 调用方（WebUI / CLI）据此决定继续等还是报错。
 *
 * @returns {Promise<{status: 'authorized', grant: object}|{status: 'pending'|'slow_down'|'expired'|'denied'}>}
 */
async function pollKiroDeviceToken(input = {}, options = {}) {
  const registration = input.registration || {};
  const clientId = String(registration.clientId || '').trim();
  const clientSecret = String(registration.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw deviceError('kiro_device_missing_client_registration');
  const deviceCode = String(input.deviceCode || '').trim();
  if (!deviceCode) throw deviceError('kiro_device_missing_device_code');

  const { status, document } = await postJson('/token', {
    clientId,
    clientSecret,
    grantType: KIRO_DEVICE_GRANT,
    deviceCode
  }, { ...options, region: registration.region || input.region });

  if (status === 200) {
    const accessToken = String(document && document.accessToken || '').trim();
    if (!accessToken) throw deviceError('kiro_device_missing_access_token');
    const expiresInSeconds = Number(document && document.expiresIn);
    return {
      status: 'authorized',
      grant: {
        accessToken,
        refreshToken: String(document && document.refreshToken || '').trim(),
        expiresAtMs: Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
          ? expiresInSeconds * 1000
          : 3600 * 1000),
        region: normalizeRegion(registration.region || input.region)
      }
    };
  }

  const upstream = String(document && document.error || '').trim();
  if (status === 400 && upstream === 'authorization_pending') return { status: 'pending' };
  if (status === 400 && upstream === 'slow_down') return { status: 'slow_down' };
  if (status === 400 && upstream === 'expired_token') return { status: 'expired' };
  if (status === 400 && upstream === 'access_denied') return { status: 'denied' };
  // clientSecret 过期/被吊销时必须能区分出来（否则会被读成「用户拒绝授权」而白等）。
  if (status === 401) throw deviceError('kiro_device_invalid_client');
  throw deviceError(`kiro_device_token_http_${status || 'failed'}`);
}

module.exports = {
  KIRO_BUILDER_ID_START_URL,
  KIRO_CLIENT_TYPE,
  KIRO_DEVICE_GRANT,
  KIRO_OIDC_SCOPES,
  KIRO_REFRESH_GRANT,
  normalizeRegion,
  pollKiroDeviceToken,
  registerKiroOidcClient,
  resolveKiroOidcEndpoint,
  startKiroDeviceAuthorization
};
