'use strict';

// kiro 的 **Kiro Desktop / social 刷新口径** —— 只要一个 refresh_token 就能自刷新，
// 不需要 device-registration（clientId/clientSecret），也不需要本地 CLI / IDE。
//
// 事实（2026-10-15 取证；社区两个独立项目同口径）：
//   POST https://prod.<region>.auth.desktop.kiro.dev/refreshToken
//   { "refreshToken": "..." }            ← JSON，没有 client_secret
//   → 200 { accessToken, refreshToken, expiresIn, profileArn? }
// 参照：jwadow/kiro-gateway 的 AuthType.KIRO_DESKTOP（kiro/auth.py）与 abuhanna/winusage 的
// docs/providers/kiro.md（Kiro IDE 的 ~/.aws/sso/cache/kiro-auth-token.json 形态：social 登录只存
// refreshToken + profileArn + authMethod/provider）。
//
// 与 AWS SSO OIDC 口径（lib/account/kiro-token-refresh.js）的分工：
//   * oidc    —— 凭据带 device-registration → https://oidc.<region>.amazonaws.com/token
//   * desktop —— Google/GitHub social 账号只有 refresh_token → prod.<region>.auth.desktop.kiro.dev
// 两条口径产出的 grant 形状相同（access_token / refresh_token / expires_at），下游采集与推理不区分。
//
// 只有 us-east-1 有 DNS 记录（社区 region sweep 实测），因此默认 us-east-1；允许显式覆盖，
// 以便上游将来扩区时不必改代码。

const DEFAULT_AUTH_REGION = 'us-east-1';
const TIMEOUT_MS = 10000;

function desktopRefreshError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeRegion(value) {
  const region = String(value || '').trim();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? region : DEFAULT_AUTH_REGION;
}

function resolveKiroDesktopRefreshEndpoint(region) {
  return `https://prod.${normalizeRegion(region)}.auth.desktop.kiro.dev/refreshToken`;
}

/**
 * 用 refresh_token 换新的 access_token（Kiro Desktop / social 口径，纯 HTTP）。
 *
 * @param {{refreshToken: string, region?: string}} input
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAtMs: number, region: string, profileArn: string}>}
 */
async function refreshKiroDesktopGrant(input, options = {}) {
  const refreshToken = String(input && input.refreshToken || '').trim();
  if (!refreshToken) throw desktopRefreshError('kiro_desktop_refresh_missing_refresh_token');

  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw desktopRefreshError('kiro_desktop_refresh_transport_unavailable');
  const region = normalizeRegion(input && input.region);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(resolveKiroDesktopRefreshEndpoint(region), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      redirect: 'error',
      signal: controller.signal
    });
    if (!response || response.status !== 200) {
      // 401/403 单独成码：social 账号的 refresh_token 被吊销（换过账号 / 登出）时要能和网络故障区分开，
      // 否则又会退化成「看着像权限问题、其实是授权已失效」的误判。
      const status = response && response.status ? response.status : 'failed';
      throw desktopRefreshError(status === 401 || status === 403
        ? 'kiro_desktop_refresh_unauthorized'
        : `kiro_desktop_refresh_http_${status}`);
    }
    const document = await response.json().catch(() => null);
    const accessToken = String(document && document.accessToken || '').trim();
    if (!accessToken) throw desktopRefreshError('kiro_desktop_refresh_missing_access_token');
    const expiresInSeconds = Number(document && document.expiresIn);
    return {
      accessToken,
      // 未轮换时沿用旧 refresh_token（与 OIDC 口径同一约定）。
      refreshToken: String(document && document.refreshToken || '').trim() || refreshToken,
      expiresAtMs: Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? expiresInSeconds * 1000
        : 3600 * 1000),
      region,
      // social 账号的 profileArn 由刷新响应直接给出（winusage 实测字段），拿到就顺手带回。
      profileArn: String(document && document.profileArn || '').trim()
    };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('kiro_desktop_refresh_')) throw error;
    throw desktopRefreshError(controller.signal.aborted ? 'kiro_desktop_refresh_timeout' : 'kiro_desktop_refresh_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_AUTH_REGION,
  normalizeRegion,
  resolveKiroDesktopRefreshEndpoint,
  refreshKiroDesktopGrant
};
