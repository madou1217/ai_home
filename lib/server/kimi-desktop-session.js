'use strict';

// kimi 桌面版（Kimi Work）Web session 托管。
// 桌面 App 的登录态是 kimi.com Web session（access_token/refresh_token，HS512，
// aud=kimi.com），与 kimi-code CLI OAuth token（ES256，scope=kimi-code）不可互换。
// 当前托管入口使用官方扫码登录 RPC（auth.kimi.com 的 account.gateway.v1.AuthService）：
//   CreateLoginQRCode → 用户用微信扫码确认 → GetLoginQRCodeStatus(SUCCESS)
//   → 拿到 web access_token + refresh_token → 托管在 nativeAuth.desktopSession，
//   打开桌面 App 时写入隔离 profile 的 token store。
// web refresh_token 有效期约 90 天且随用轮换，RefreshToken RPC 可续期托管。

const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('./account-credential-store');
const { resolveAccountRef } = require('./account-ref-store');
const { parseJwtExpiryMs } = require('../account/codex-auth-metadata');

const DEFAULT_AUTH_BASE_URL = 'https://auth.kimi.com/api';
const AUTH_SERVICE = 'account.gateway.v1.AuthService';
const DEFAULT_TIMEOUT_MS = 10_000;
// web access_token 实测 15 分钟有效期；提前 2 分钟续期
const ACCESS_TOKEN_SKEW_MS = 2 * 60 * 1000;
const QR_CODE_TTL_MS = 3 * 60 * 1000;

const QR_STATUS = Object.freeze({
  PENDING: 'STATUS_PENDING',
  SCANNED: 'STATUS_SCANNED',
  EXPIRED: 'STATUS_EXPIRED',
  SUCCESS: 'STATUS_SUCCESS'
});

function resolveAuthBaseUrl(deps = {}) {
  return String(
    deps.authBaseUrl || process.env.KIMI_DESKTOP_SESSION_AUTH_BASE || DEFAULT_AUTH_BASE_URL
  ).trim().replace(/\/+$/, '');
}

function resolveFetch(deps = {}) {
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  return fetchImpl;
}

function readStringField(data, ...names) {
  for (const name of names) {
    const value = String(data && data[name] || '').trim();
    if (value) return value;
  }
  return '';
}

async function callAuthService(deps, method, payload, accessToken) {
  const fetchImpl = resolveFetch(deps);
  const timeoutMs = Math.max(1_000, Number(deps.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${resolveAuthBaseUrl(deps)}/${AUTH_SERVICE}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function createDesktopLoginQRCode(deps = {}) {
  const { status, data } = await callAuthService(deps, 'CreateLoginQRCode', {});
  const code = String(data && data.code || '').trim();
  if (status !== 200 || !code) {
    return { ok: false, error: `create_qrcode_http_${status || 'unknown'}` };
  }
  return {
    ok: true,
    code,
    // 与官方登录页一致：微信扫码打开 /wechat/mp/auth?id=<code> 完成确认
    qrUrl: `https://www.kimi.com/wechat/mp/auth?id=${encodeURIComponent(code)}`,
    expiresAtMs: Date.now() + QR_CODE_TTL_MS
  };
}

async function getDesktopLoginQRCodeStatus(deps = {}, code) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) return { ok: false, error: 'missing_code' };
  const { status, data } = await callAuthService(deps, 'GetLoginQRCodeStatus', { code: normalizedCode });
  if (status !== 200 || !data || typeof data !== 'object') {
    return { ok: false, error: `qrcode_status_http_${status || 'unknown'}` };
  }
  const state = String(data.status || '').trim();
  const result = { ok: true, status: state || QR_STATUS.PENDING };
  if (state === QR_STATUS.SUCCESS) {
    // 官方 Kimi Work 3.2.1 的 Connect 客户端把 protobuf 字段解码为
    // camelCase；保留 snake_case 兼容直接返回 proto field name 的网关。
    result.accessToken = readStringField(data, 'accessToken', 'access_token');
    result.refreshToken = readStringField(data, 'refreshToken', 'refresh_token');
    result.userId = readStringField(data, 'userId', 'user_id');
    if (!result.accessToken || !result.refreshToken) {
      return { ok: false, error: 'qrcode_success_without_tokens' };
    }
  }
  return result;
}

async function refreshDesktopSessionToken(deps = {}, refreshToken) {
  const normalized = String(refreshToken || '').trim();
  if (!normalized) return { ok: false, error: 'missing_refresh_token' };
  const { status, data } = await callAuthService(deps, 'RefreshToken', { refresh_token: normalized });
  const accessToken = readStringField(data, 'accessToken', 'access_token');
  if (status !== 200 || !accessToken) {
    return { ok: false, error: status === 401 || status === 403
      ? 'desktop_session_refresh_unauthorized'
      : `desktop_session_refresh_http_${status || 'unknown'}` };
  }
  return {
    ok: true,
    accessToken,
    refreshToken: readStringField(data, 'refreshToken', 'refresh_token') || normalized
  };
}

function readDesktopSession(record) {
  const session = record && record.nativeAuth && record.nativeAuth.desktopSession;
  if (!session || typeof session !== 'object') return null;
  const refreshToken = String(session.refreshToken || '').trim();
  if (!refreshToken) return null;
  return {
    accessToken: String(session.accessToken || '').trim(),
    refreshToken,
    userId: String(session.userId || '').trim(),
    updatedAtMs: Number(session.updatedAtMs) || 0
  };
}

function writeDesktopSession(fsImpl, aiHomeDir, accountRef, session) {
  const record = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
  // 凭证行可能尚未创建（账号注册后从未写入 env/nativeAuth），
  // 此时从 account_refs 取 provider 校验；writeAccountNativeAuth 会 upsert 建行。
  const provider = record
    ? record.provider
    : (resolveAccountRef(fsImpl, aiHomeDir, accountRef, { bestEffort: true }) || {}).provider;
  if (provider !== 'kimi') return false;
  writeAccountNativeAuth(fsImpl, aiHomeDir, accountRef, {
    ...(record && record.nativeAuth && typeof record.nativeAuth === 'object' ? record.nativeAuth : {}),
    desktopSession: {
      accessToken: String(session.accessToken || '').trim(),
      refreshToken: String(session.refreshToken || '').trim(),
      userId: String(session.userId || '').trim(),
      updatedAtMs: Number(session.updatedAtMs) || Date.now()
    }
  });
  return true;
}

// 返回可用于注入桌面 profile 的新鲜 accessToken；access 过期时用托管的
// refresh_token 走 RefreshToken RPC 续期并回写（refresh_token 随用轮换）。
async function ensureDesktopSessionAccessToken(fsImpl, aiHomeDir, accountRef, deps = {}) {
  const record = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
  const session = readDesktopSession(record);
  if (!session) return { ok: false, error: 'desktop_session_missing' };
  const accessExpiryMs = parseJwtExpiryMs(session.accessToken) || 0;
  if (session.accessToken && accessExpiryMs - Date.now() > ACCESS_TOKEN_SKEW_MS) {
    return { ok: true, accessToken: session.accessToken, refreshed: false };
  }
  const refreshed = await refreshDesktopSessionToken(deps, session.refreshToken);
  if (!refreshed.ok) return { ok: false, error: refreshed.error };
  writeDesktopSession(fsImpl, aiHomeDir, accountRef, {
    ...session,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken
  });
  return { ok: true, accessToken: refreshed.accessToken, refreshed: true };
}

module.exports = {
  createDesktopLoginQRCode,
  getDesktopLoginQRCodeStatus,
  refreshDesktopSessionToken,
  readDesktopSession,
  writeDesktopSession,
  ensureDesktopSessionAccessToken,
  QR_STATUS,
  DEFAULT_AUTH_BASE_URL
};
