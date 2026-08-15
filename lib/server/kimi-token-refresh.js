'use strict';

// kimi (kimi-code) OAuth access_token 刷新。
// kimi access_token 有效期只有 15 分钟（expires_in=900），必须按 refresh_token 续期，
// 否则所有依赖 access_token 的链路（运行池加载、配额探测）会在登录一刻钟后集体失效。
// 端点与 kimi-code CLI 保持一致（@moonshot-ai/kimi-code dist/main.mjs refreshAccessToken）：
//   POST {oauthHost}/api/oauth/token  form: client_id + grant_type=refresh_token + refresh_token
// 凭证落在 native_auth_json 的 $.credentials（access_token/refresh_token/expires_at 秒级 epoch）。

const fs = require('node:fs');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('./account-credential-store');

const DEFAULT_KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_CODE_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const DEFAULT_REFRESH_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 30_000;

function decodeJwtPayloadUnsafe(jwt) {
  const text = String(jwt || '').trim();
  const parts = text.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function parseJwtExpiryMs(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  const expSeconds = Number(payload && payload.exp);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
  return expSeconds * 1000;
}

// $.credentials.expires_at 是秒级 epoch（kimi-code 落盘格式）；缺失时回退 JWT exp。
function resolveKimiTokenExpiryMs(credentials) {
  if (!credentials || typeof credentials !== 'object') return null;
  const direct = Number(credentials.expires_at ?? credentials.expiresAt);
  if (Number.isFinite(direct) && direct > 0) {
    return direct > 1e12 ? direct : direct * 1000;
  }
  return parseJwtExpiryMs(credentials.access_token || credentials.accessToken);
}

function readKimiOAuthCredentials(fsImpl, aiHomeDir, accountRef) {
  const nativeAuth = readAccountNativeAuth(fsImpl, aiHomeDir, accountRef);
  const credentials = nativeAuth && nativeAuth.credentials;
  return credentials && typeof credentials === 'object' ? credentials : null;
}

function persistKimiOAuthTokens(fsImpl, aiHomeDir, accountRef, tokens, nowMs) {
  const nativeAuth = readAccountNativeAuth(fsImpl, aiHomeDir, accountRef);
  const current = nativeAuth && nativeAuth.credentials;
  if (!current || typeof current !== 'object') return false;
  const expiresAtSeconds = Number.isFinite(tokens.expiresAtMs) && tokens.expiresAtMs > 0
    ? Math.floor(tokens.expiresAtMs / 1000)
    : Math.floor(nowMs / 1000) + Number(tokens.expiresIn || 900);
  writeAccountNativeAuth(fsImpl, aiHomeDir, accountRef, {
    ...nativeAuth,
    credentials: {
      ...current,
      access_token: String(tokens.accessToken || ''),
      refresh_token: String(tokens.refreshToken || current.refresh_token || ''),
      expires_at: expiresAtSeconds,
      expires_in: Number(tokens.expiresIn) || 900,
      token_type: String(tokens.tokenType || current.token_type || 'Bearer'),
      scope: String(tokens.scope || current.scope || '')
    }
  });
  return true;
}

async function refreshKimiAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }
  const fsImpl = deps.fs || fs;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const accountRef = String(account.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) {
    return { ok: false, refreshed: false, reason: 'missing_account_ref' };
  }

  const credentials = readKimiOAuthCredentials(fsImpl, aiHomeDir, accountRef);
  if (!credentials) {
    return { ok: false, refreshed: false, reason: 'missing_credentials' };
  }
  const refreshToken = String(credentials.refresh_token || credentials.refreshToken || '').trim();
  if (!refreshToken) {
    return { ok: false, refreshed: false, reason: 'missing_refresh_token' };
  }

  const fetchWithTimeout = deps.fetchWithTimeout;
  if (typeof fetchWithTimeout !== 'function') {
    return { ok: false, refreshed: false, reason: 'refresh_executor_missing' };
  }

  const nowMs = Number(options.nowMs) || Date.now();
  const force = !!options.force;
  const skewMs = Math.max(10_000, Number(options.skewMs) || DEFAULT_REFRESH_SKEW_MS);
  const expiresAtMs = resolveKimiTokenExpiryMs(credentials);
  if (!force && Number.isFinite(expiresAtMs) && expiresAtMs - nowMs > skewMs) {
    return { ok: true, refreshed: false, reason: 'not_due' };
  }

  // 同一账号的并发刷新去重 + 最小尝试间隔，避免配额探测与网关同时打到刷新端点。
  if (account._kimiRefreshPromise) return account._kimiRefreshPromise;
  const minAttemptIntervalMs = Math.max(1_000, Number(options.minAttemptIntervalMs) || DEFAULT_MIN_ATTEMPT_INTERVAL_MS);
  if (!force && Number.isFinite(account._kimiRefreshLastAttemptAt)
    && nowMs - account._kimiRefreshLastAttemptAt < minAttemptIntervalMs) {
    return { ok: false, refreshed: false, reason: 'throttled' };
  }
  account._kimiRefreshLastAttemptAt = nowMs;

  const oauthHost = String(deps.oauthHost || process.env.KIMI_CODE_OAUTH_HOST || DEFAULT_KIMI_OAUTH_HOST)
    .trim().replace(/\/+$/, '');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);

  account._kimiRefreshPromise = (async () => {
    try {
      const res = await fetchWithTimeout(`${oauthHost}/api/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: KIMI_CODE_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }).toString()
      }, timeoutMs);
      const status = res && res.status;
      const data = await res.json().catch(() => null);
      if (status !== 200 || !data || typeof data.access_token !== 'string' || !data.access_token) {
        const errorCode = data && typeof data.error === 'string' ? data.error : '';
        const reason = status === 401 || status === 403 || errorCode === 'invalid_grant'
          ? 'refresh_unauthorized'
          : `refresh_http_${status || 'unknown'}`;
        return { ok: false, refreshed: false, reason };
      }
      const expiresIn = Number(data.expires_in);
      const tokens = {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refreshToken,
        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
        expiresAtMs: Number.isFinite(expiresIn) && expiresIn > 0
          ? Date.now() + expiresIn * 1000
          : (parseJwtExpiryMs(data.access_token) || Date.now() + 900 * 1000),
        tokenType: data.token_type,
        scope: data.scope
      };
      persistKimiOAuthTokens(fsImpl, aiHomeDir, accountRef, tokens, Date.now());
      return { ok: true, refreshed: true, accessToken: tokens.accessToken, expiresAtMs: tokens.expiresAtMs };
    } catch (error) {
      return { ok: false, refreshed: false, reason: `refresh_exception: ${String(error && error.message || error).slice(0, 120)}` };
    } finally {
      account._kimiRefreshPromise = null;
    }
  })();
  return account._kimiRefreshPromise;
}

module.exports = {
  refreshKimiAccessToken,
  DEFAULT_KIMI_OAUTH_HOST,
  KIMI_CODE_OAUTH_CLIENT_ID,
  __private: {
    decodeJwtPayloadUnsafe,
    parseJwtExpiryMs,
    resolveKimiTokenExpiryMs,
    readKimiOAuthCredentials,
    persistKimiOAuthTokens
  }
};
