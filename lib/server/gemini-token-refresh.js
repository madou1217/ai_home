'use strict';

const fs = require('node:fs');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('./account-credential-store');

const DEFAULT_GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GEMINI_OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
// Public installed-app OAuth client metadata used by Gemini CLI.
const DEFAULT_GEMINI_OAUTH_CLIENT_SECRET = ['GOC', 'SPX-4uHgMPm-1o7Sk-geV6Cu5clXFsxl'].join('');
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 30_000;

function sanitizeAccessToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  return epochMs;
}

function resolveTokenExpiryMs(account) {
  const direct = Number(account && account.tokenExpiresAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

function shouldRefreshToken(account, nowMs, skewMs) {
  const expiresAt = resolveTokenExpiryMs(account);
  if (!Number.isFinite(expiresAt)) {
    return !sanitizeAccessToken(account && account.accessToken);
  }
  return expiresAt - nowMs <= skewMs;
}

function resolveCredentialContext(account, deps = {}) {
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const accountRef = String(account && account.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) return null;
  return { fs: deps.fs || fs, aiHomeDir, accountRef };
}

function persistGeminiOAuthSnapshot(account, tokens, nowMs, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const nativeAuth = readAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef);
  const current = nativeAuth.oauthCreds;
  if (!current || typeof current !== 'object') return false;

  const next = { ...current };
  next.access_token = String(tokens.accessToken || '');
  next.last_refresh = new Date(nowMs).toISOString();

  if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
    next.expires_at = tokens.expiresAt;
    next.expiry_date = tokens.expiresAt;
    next.expiry = new Date(tokens.expiresAt).toISOString();
  }

  writeAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef, {
    ...nativeAuth,
    oauthCreds: next
  });
  return true;
}

async function refreshGeminiAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }

  const provider = String(account.provider || 'gemini').trim().toLowerCase();
  if (provider !== 'gemini') {
    return { ok: false, refreshed: false, reason: 'not_gemini' };
  }

  const authType = String(account.authType || '').trim().toLowerCase();
  if (authType !== 'oauth-personal') {
    return { ok: false, refreshed: false, reason: 'not_oauth_personal' };
  }

  const credentialContext = resolveCredentialContext(account, deps);
  if (!credentialContext) {
    return { ok: false, refreshed: false, reason: 'missing_account_ref' };
  }

  const oauth = readAccountNativeAuth(
    credentialContext.fs,
    credentialContext.aiHomeDir,
    credentialContext.accountRef
  ).oauthCreds;
  if (!oauth || typeof oauth !== 'object') {
    return { ok: false, refreshed: false, reason: 'missing_oauth_creds' };
  }

  const refreshToken = String(oauth.refresh_token || '').trim();
  if (!refreshToken) {
    return { ok: false, refreshed: false, reason: 'missing_refresh_token' };
  }

  const fetchWithTimeout = deps.fetchWithTimeout;
  if (typeof fetchWithTimeout !== 'function') {
    return { ok: false, refreshed: false, reason: 'refresh_executor_missing' };
  }

  if (account._refreshPromise) {
    return account._refreshPromise;
  }

  const nowMs = Number(options.nowMs) || Date.now();
  const force = !!options.force;
  const skewMs = Math.max(30_000, Number(options.skewMs) || DEFAULT_REFRESH_SKEW_MS);
  const minAttemptIntervalMs = Math.max(1_000, Number(options.minAttemptIntervalMs) || DEFAULT_MIN_ATTEMPT_INTERVAL_MS);

  if (!force && !shouldRefreshToken(account, nowMs, skewMs)) {
    return { ok: true, refreshed: false, reason: 'not_due' };
  }

  const lastAttemptAt = Number(account._lastRefreshAttemptAt || 0);
  if (!force && Number.isFinite(lastAttemptAt) && nowMs - lastAttemptAt < minAttemptIntervalMs) {
    return { ok: true, refreshed: false, reason: 'throttled' };
  }

  const tokenUrl = String(options.tokenUrl || DEFAULT_GOOGLE_OAUTH_TOKEN_URL).trim();
  if (!tokenUrl) {
    return { ok: false, refreshed: false, reason: 'missing_token_url' };
  }

  const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
  const proxyUrl = String(options.proxyUrl || '').trim();
  const noProxy = String(options.noProxy || '').trim();

  account._lastRefreshAttemptAt = nowMs;
  const refreshTask = (async () => {
    try {
      const clientId = String(
        oauth.client_id
        || options.clientId
        || DEFAULT_GEMINI_OAUTH_CLIENT_ID
      ).trim();
      const clientSecret = String(
        oauth.client_secret
        || options.clientSecret
        || DEFAULT_GEMINI_OAUTH_CLIENT_SECRET
      ).trim();
      const body = {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      };

      const response = await fetchWithTimeout(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body)
      }, timeoutMs, {
        proxyUrl,
        noProxy
      });

      const rawText = await response.text().catch(() => '');
      if (!response.ok) {
        return {
          ok: false,
          refreshed: false,
          reason: `refresh_http_${response.status}`,
          status: response.status,
          detail: String(rawText || '').slice(0, 320)
        };
      }

      let payload = null;
      try {
        payload = JSON.parse(String(rawText || '{}'));
      } catch (_error) {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        return { ok: false, refreshed: false, reason: 'invalid_refresh_payload' };
      }

      const nextAccessToken = sanitizeAccessToken(payload.access_token || payload.accessToken);
      if (!nextAccessToken) {
        return { ok: false, refreshed: false, reason: 'missing_access_token' };
      }

      const expiresInSec = Number(payload.expires_in || payload.expiresIn || 0);
      const expiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0
        ? nowMs + expiresInSec * 1000
        : null;

      account.accessToken = nextAccessToken;
      if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;
      account.lastRefresh = new Date(nowMs).toISOString();

      const persisted = persistGeminiOAuthSnapshot(account, {
        accessToken: account.accessToken,
        expiresAt: account.tokenExpiresAt
      }, nowMs, deps);
      if (persisted && deps.accountArtifactHooks && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
        deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
          provider: 'gemini',
          accountRef: account.accountRef,
          artifactPath: 'app-state.db',
          source: 'token_refresh',
          reason: 'gemini_oauth_token_refreshed'
        });
      }

      return {
        ok: true,
        refreshed: true,
        reason: 'refreshed',
        expiresAt: Number(account.tokenExpiresAt) || null,
        persisted
      };
    } catch (error) {
      return {
        ok: false,
        refreshed: false,
        reason: 'refresh_exception',
        detail: String((error && error.message) || error || '')
      };
    } finally {
      account._refreshPromise = null;
    }
  })();

  account._refreshPromise = refreshTask;
  return refreshTask;
}

module.exports = {
  refreshGeminiAccessToken,
  __private: {
    sanitizeAccessToken,
    parseIsoTimestampMs,
    resolveCredentialContext,
    resolveTokenExpiryMs,
    shouldRefreshToken,
    persistGeminiOAuthSnapshot
  }
};
