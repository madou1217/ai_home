'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
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

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function resolveTokenExpiryMs(account) {
  const direct = Number(account && account.tokenExpiresAt);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const configDir = String(account && account.configDir || '').trim();
  if (!configDir) return null;

  const oauthPath = path.join(configDir, 'oauth_creds.json');
  const oauth = readJsonFileSafe(oauthPath);
  if (!oauth) return null;

  const expiresAt = Number(oauth.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;

  const expiryIso = parseIsoTimestampMs(oauth.expiry || oauth.expires_in);
  if (Number.isFinite(expiryIso)) return expiryIso;

  return null;
}

function shouldRefreshToken(account, nowMs, skewMs) {
  const expiresAt = resolveTokenExpiryMs(account);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - nowMs <= skewMs;
}

function persistGeminiOAuthSnapshot(account, tokens, nowMs) {
  const configDir = String(account && account.configDir || '').trim();
  if (!configDir) return false;

  const oauthPath = path.join(configDir, 'oauth_creds.json');
  const current = readJsonFileSafe(oauthPath);
  if (!current || typeof current !== 'object') return false;

  const next = { ...current };
  next.access_token = String(tokens.accessToken || '');
  next.last_refresh = new Date(nowMs).toISOString();

  if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
    next.expires_at = tokens.expiresAt;
    next.expiry = new Date(tokens.expiresAt).toISOString();
  }

  try {
    fs.mkdirSync(path.dirname(oauthPath), { recursive: true });
    fs.writeFileSync(oauthPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (_error) {
    return false;
  }
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

  const configDir = String(account.configDir || '').trim();
  if (!configDir) {
    return { ok: false, refreshed: false, reason: 'missing_config_dir' };
  }

  const oauthPath = path.join(configDir, 'oauth_creds.json');
  const oauth = readJsonFileSafe(oauthPath);
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
      const body = {
        client_id: String(oauth.client_id || '').trim(),
        client_secret: String(oauth.client_secret || '').trim(),
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
      }, nowMs);

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
    resolveTokenExpiryMs,
    shouldRefreshToken,
    persistGeminiOAuthSnapshot
  }
};
