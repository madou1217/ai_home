'use strict';

// OAuth 账号的「推理凭据解析器」——把登录态 access_token 换成**上游认可的推理凭据**。
//
// 为什么需要它（2026-10-24 取证，源：桌面端 app.asar 的 ZaiBusinessTokenResolver）：
//   OAuth 登录拿到的 access_token **不能直接用于推理**。桌面端在
//   `normalizePolledTokenSet` 里对它做 `businessTokenResolver.resolve(accessToken)`，
//   即先换成一个业务 token（PAT）才拿去发推理请求。不做这一步，推理端点会返回
//   `{"code":3012,"msg":"request has been blocked due to unusual activity."}` 或
//   `{"code":1005,"msg":"exceed quota limit"}` —— 看起来像风控，其实是**用错了凭据**。
//
// 官方协议（apps/zcode-cli/docs/design/v2/auth-login.md + 桌面端实现一致）：
//   POST <businessLoginUrl>   body {"token": <oauth access_token>}
//     → { code, success, data: { access_token | accessToken, expires_in } }
//   code ∈ {0,200}（数字或字符串）且 success !== false 才算成功。
//
// 缓存策略（照抄桌面端，避免重复打上游）：
//   同一 oauthAccessToken 且 now < expiresAt - 60s 时复用缓存；否则重新换取。
//   **上游对频繁换取敏感，因此缓存是硬要求，不是优化。**
//
// 本模块只做协议与缓存，不认识任何 provider 名 —— 谁需要 PAT 由描述符声明
// （`capabilities.relay.auth = { kind: 'business_token', loginUrl }`），
// 由 lib/server/upstream-credential-resolver.js 按能力倒排调用。

const DEFAULT_BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';
const DEFAULT_TIMEOUT_MS = 10_000;
// 缓存提前量：与桌面端一致（Ibe = 6e4）。上游在 token 临近过期时可能已拒绝，
// 留 60s 余量可避免「刚好在边界上」的失败。
const EXPIRY_SKEW_MS = 60 * 1000;

const ZAI_BUSINESS_LOGIN_URL = DEFAULT_BUSINESS_LOGIN_URL;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 上游成功码：数字/字符串 0 或 200；缺省视为成功（与桌面端 isSuccessfulZaiBusinessCode 一致）。 */
function isSuccessfulBusinessCode(code) {
  if (code === null || code === undefined) return true;
  if (typeof code === 'number') return code === 0 || code === 200;
  if (typeof code === 'string') return code === '0' || code === '200';
  return false;
}

function businessTokenError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/**
 * 创建带缓存的业务 token 解析器。
 *
 * @param {object} options
 * @param {string} options.loginUrl   业务登录端点（描述符声明）
 * @param {function} options.request  (url, init, timeoutMs) => Promise<Response>
 * @param {number} [options.timeoutMs]
 * @param {function} [options.now]
 */
function createBusinessTokenResolver(options = {}) {
  const loginUrl = normalizeString(options.loginUrl) || DEFAULT_BUSINESS_LOGIN_URL;
  const request = options.request;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // 单飞：并发请求共用同一次换取，避免同时打上游（上游对并发换取敏感）。
  let inFlight = null;
  let cached = null;

  function isCachedValid(oauthAccessToken) {
    return Boolean(cached
      && cached.oauthAccessToken === oauthAccessToken
      && cached.expiresAt - EXPIRY_SKEW_MS > now());
  }

  async function exchange(oauthAccessToken) {
    let response;
    try {
      response = await request(loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token: oauthAccessToken })
      }, timeoutMs);
    } catch (_error) {
      // 网络层失败不区分原因，统一按「需要重新登录」上报（与桌面端同口径）。
      throw businessTokenError('zai_oauth_required', '换取业务 token 失败（网络）');
    }
    if (!response || response.ok === false) {
      throw businessTokenError('zai_oauth_required', `换取业务 token 失败（HTTP ${Number(response && response.status) || 0}）`);
    }
    const rawText = await response.text().catch(() => '');
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch (_error) {
      payload = null;
    }
    if (!payload || typeof payload !== 'object') {
      throw businessTokenError('zai_oauth_required', '换取业务 token 响应无效');
    }
    if (!isSuccessfulBusinessCode(payload.code) || payload.success === false) {
      throw businessTokenError('zai_oauth_required', normalizeString(payload.msg) || '换取业务 token 被拒');
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const accessToken = normalizeString(data.access_token) || normalizeString(data.accessToken);
    if (!accessToken) {
      throw businessTokenError('zai_oauth_required', '换取业务 token 响应缺少 access_token');
    }
    const expiresIn = Number(data.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      cached = { oauthAccessToken, accessToken, expiresAt: now() + expiresIn * 1000 };
    } else {
      // 上游未给有效期时不缓存（无有效期元数据不降级），下次重新换取。
      cached = null;
    }
    return accessToken;
  }

  /** 把 oauth access_token 解析成可用于推理的业务 token。 */
  async function resolve(oauthAccessToken) {
    const source = normalizeString(oauthAccessToken);
    if (!source) throw businessTokenError('zai_oauth_required', '缺少 OAuth access token');
    if (isCachedValid(source)) return cached.accessToken;
    cached = null;
    if (inFlight && inFlight.oauthAccessToken === source) return inFlight.promise;
    const promise = exchange(source).finally(() => {
      if (inFlight && inFlight.promise === promise) inFlight = null;
    });
    inFlight = { oauthAccessToken: source, promise };
    return promise;
  }

  function clear() {
    cached = null;
    inFlight = null;
  }

  return { resolve, clear, loginUrl };
}

module.exports = {
  ZAI_BUSINESS_LOGIN_URL,
  DEFAULT_TIMEOUT_MS,
  EXPIRY_SKEW_MS,
  isSuccessfulBusinessCode,
  createBusinessTokenResolver
};
