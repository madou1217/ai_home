'use strict';

// kiro 的 **social 设备码授权**（Google / GitHub）—— 与 Builder ID 的设备码是**两套不同协议**。
//
// 为什么必须单独一份（2026-10-17 实测）：
//   * Builder ID / IdC 走 AWS SSO OIDC（`oidc.<region>.amazonaws.com`，见 kiro-device-authorization.js）；
//   * Google / GitHub 走 Kiro 自己的认证服务（`prod.<region>.auth.desktop.kiro.dev`），
//     同一个 device flow 外壳，但端点、字段名、状态语义都不同。
//   混用会得到「未登录 / 无效客户端」这类看着像权限问题的假故障。
//
// 三步纯 HTTP（官方 kiro-cli 的 crates/fig_auth/src/social.rs 同口径）：
//   1) POST /oauth/device/authorization {clientId, loginProvider}
//        → deviceCode / userCode / verificationUri(Complete) / expiresInMilliseconds / intervalInMilliseconds
//   2) 用户在任意设备打开 verificationUriComplete 完成 Google/GitHub 授权
//   3) POST /oauth/device/poll {clientId, deviceCode}
//        → 200 {status, accessToken, refreshToken, profileArn, identityProvider}
//          未完成时 status='authorization_pending'（**HTTP 仍是 200**，不是 400 —— 与 OIDC 口径的关键差异）；
//          设备码失效 status='invalid_token'。
//
// **为什么这是「从其他电脑登录」的正解**：social 的浏览器 PKCE 流程要求 localhost 回调
// （`--use-device-flow` 只对 Builder ID / IdC 生效），在远程机器上回调打不通 —— 用户遇到的
// 「换台电脑就报错」正是这个。设备流没有回调，任意机器都能完成授权。
//
// 产出与 social 导入（importKiroRefreshToken）**完全同构**的 auth 行：authMethod='social' +
// provider + profileArn，因此判型、刷新、采集三条链路一行都不用改。

const DEFAULT_AUTH_REGION = 'us-east-1';
const TIMEOUT_MS = 15000;

// 官方 kiro-cli 的 social 客户端标识（二进制常量；上游只校验非空，不校验取值，
// 但**沿用官方的值**才不会在将来上游收紧校验时被拒）。
const KIRO_SOCIAL_CLIENT_ID = '820fd6d1-95c0-4ca4-bffb-3f01d32da842';

// 登录提供方 —— 官方 CLI 的枚举（Google / Github）。
const KIRO_SOCIAL_PROVIDERS = Object.freeze({ GOOGLE: 'Google', GITHUB: 'Github' });

function socialError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeRegion(value) {
  const region = String(value || '').trim();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? region : DEFAULT_AUTH_REGION;
}

/** social 认证服务端点（与 Kiro Desktop 刷新同一台主机，路径不同）。 */
function resolveKiroSocialEndpoint(region) {
  return `https://prod.${normalizeRegion(region)}.auth.desktop.kiro.dev`;
}

/** 归一 loginProvider；认不出的一律回落到 Google（官方 CLI 的默认顺序）。 */
function normalizeLoginProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'github' || raw === 'git') return KIRO_SOCIAL_PROVIDERS.GITHUB;
  return KIRO_SOCIAL_PROVIDERS.GOOGLE;
}

/** 统一的一次性 POST JSON：网络/解析失败都归到 `kiro_social_*` 错误码。 */
async function postJson(path, body, options = {}) {
  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw socialError('kiro_social_transport_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(`${resolveKiroSocialEndpoint(options.region)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // 上游按 UA 区分客户端；沿用官方值，不伪装成浏览器。
        'user-agent': String(options.userAgent || 'Kiro-CLI')
      },
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
    if (error && typeof error.code === 'string' && error.code.startsWith('kiro_social_')) throw error;
    throw socialError(controller.signal.aborted ? 'kiro_social_timeout' : 'kiro_social_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 第 1 步：开始 social 设备授权，拿到给用户看的 user code 与验证地址。
 *
 * @returns {Promise<{deviceCode, userCode, verificationUri, verificationUriComplete, intervalSeconds, expiresInSeconds, loginProvider}>}
 */
async function startKiroSocialDeviceAuthorization(input = {}, options = {}) {
  const loginProvider = normalizeLoginProvider(input.loginProvider || input.provider);
  const clientId = String(input.clientId || KIRO_SOCIAL_CLIENT_ID).trim();
  if (!clientId) throw socialError('kiro_social_missing_client_id');

  const { status, document } = await postJson('/oauth/device/authorization', {
    clientId,
    loginProvider
  }, options);

  if (status !== 200) throw socialError(`kiro_social_start_http_${status || 'failed'}`);
  const deviceCode = String(document && document.deviceCode || '').trim();
  const userCode = String(document && document.userCode || '').trim();
  const verificationUri = String(document && document.verificationUri || '').trim();
  if (!deviceCode || !userCode || !verificationUri) throw socialError('kiro_social_start_missing_codes');
  // 这一口径的时长字段是**毫秒**（OIDC 口径是秒）—— 单位不同，别照抄。
  const intervalMs = Number(document && document.intervalInMilliseconds);
  const expiresMs = Number(document && document.expiresInMilliseconds);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: String(document && document.verificationUriComplete || '').trim() || verificationUri,
    intervalSeconds: Number.isFinite(intervalMs) && intervalMs > 0 ? Math.round(intervalMs / 1000) : 5,
    expiresInSeconds: Number.isFinite(expiresMs) && expiresMs > 0 ? Math.round(expiresMs / 1000) : 300,
    loginProvider,
    clientId
  };
}

/**
 * 第 3 步：轮询一次 social 设备授权。
 *
 * 「用户还没批准」不是错误（pending），只有上游真出错才抛 —— 调用方据此决定继续等还是报错。
 * 注意与 OIDC 口径的差异：**pending 也是 HTTP 200**，状态在 body 的 `status` 字段里。
 *
 * @returns {Promise<{status: 'authorized', grant: object, profileArn: string, provider: string}|{status: 'pending'|'expired'}>}
 */
async function pollKiroSocialDeviceToken(input = {}, options = {}) {
  const deviceCode = String(input.deviceCode || '').trim();
  if (!deviceCode) throw socialError('kiro_social_missing_device_code');
  const clientId = String(input.clientId || KIRO_SOCIAL_CLIENT_ID).trim();

  const { status, document } = await postJson('/oauth/device/poll', {
    clientId,
    deviceCode
  }, options);

  if (status !== 200) throw socialError(`kiro_social_poll_http_${status || 'failed'}`);
  const upstream = String(document && document.status || '').trim();
  if (upstream === 'authorization_pending') return { status: 'pending' };
  if (upstream === 'invalid_token') return { status: 'expired' };

  const accessToken = String(document && document.accessToken || '').trim();
  const refreshToken = String(document && document.refreshToken || '').trim();
  if (!accessToken || !refreshToken) {
    // 拿到未知状态时**不猜**：报错比把空凭据写进账号安全。
    throw socialError(`kiro_social_poll_unexpected_status:${upstream || 'empty'}`);
  }
  const profileArn = String(document && document.profileArn || '').trim();
  const provider = String(document && document.identityProvider || '').trim();
  return {
    status: 'authorized',
    profileArn,
    provider,
    grant: {
      accessToken,
      refreshToken,
      // social 口径不返回 expires_in：access token 寿命按官方惯例取 1 小时，
      // 但**刷新永远可用**（refresh_token 是长期凭据），因此这里的时长只影响何时触发刷新。
      expiresAtMs: Date.now() + 3600 * 1000,
      region: normalizeRegion(options.region)
    }
  };
}

module.exports = {
  KIRO_SOCIAL_CLIENT_ID,
  KIRO_SOCIAL_PROVIDERS,
  normalizeLoginProvider,
  normalizeRegion,
  pollKiroSocialDeviceToken,
  resolveKiroSocialEndpoint,
  startKiroSocialDeviceAuthorization
};
