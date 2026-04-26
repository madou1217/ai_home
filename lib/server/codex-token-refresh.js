'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_CLI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 30_000;

function sanitizeAccessToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

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

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  return epochMs;
}

function parseJwtExpiryMs(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  const expSeconds = Number(payload && payload.exp);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
  return expSeconds * 1000;
}

function resolveTokenExpiryMs(account) {
  const direct = Number(account && account.tokenExpiresAt);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const legacy = parseIsoTimestampMs(account && account.expiredAt);
  if (Number.isFinite(legacy)) return legacy;

  return parseJwtExpiryMs(account && account.accessToken);
}

function shouldRefreshToken(account, nowMs, skewMs) {
  const expiresAt = resolveTokenExpiryMs(account);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - nowMs <= skewMs;
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function persistCodexAuthSnapshot(account, tokens, nowMs) {
  const authPath = String(account && account.codexAuthPath || '').trim();
  if (!authPath) return false;

  const current = readJsonFileSafe(authPath);
  const next = current && typeof current === 'object' ? { ...current } : {};
  const currentTokens = next.tokens && typeof next.tokens === 'object' ? { ...next.tokens } : {};

  currentTokens.access_token = String(tokens.accessToken || '');
  if (tokens.idToken) currentTokens.id_token = String(tokens.idToken || '');
  if (tokens.refreshToken) currentTokens.refresh_token = String(tokens.refreshToken || '');
  if (tokens.accountId) currentTokens.account_id = String(tokens.accountId || '');

  next.tokens = currentTokens;
  next.last_refresh = new Date(nowMs).toISOString();
  if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
    next.expired = new Date(tokens.expiresAt).toISOString();
  }

  try {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (_error) {
    return false;
  }
}

function buildRefreshRequestBody(account) {
  const accountClientId = String(account && account.oauthClientId || '').trim();
  const accessTokenPayload = decodeJwtPayloadUnsafe(account && account.accessToken);
  const accessTokenClientId = String(
    accessTokenPayload
    && accessTokenPayload.client_id
    || ''
  ).trim();
  const clientId = accountClientId || accessTokenClientId || DEFAULT_CLI_CLIENT_ID;

  return {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: String(account && account.refreshToken || '').trim(),
    scope: 'openid profile email offline_access'
  };
}

async function refreshCodexAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }

  const provider = String(account.provider || 'codex').trim().toLowerCase();
  if (provider !== 'codex') {
    return { ok: false, refreshed: false, reason: 'not_codex' };
  }

  const refreshToken = String(account.refreshToken || '').trim();
  if (!refreshToken.startsWith('rt_')) {
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

  const tokenUrl = String(options.tokenUrl || DEFAULT_OPENAI_OAUTH_TOKEN_URL).trim();
  if (!tokenUrl) {
    return { ok: false, refreshed: false, reason: 'missing_token_url' };
  }

  const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
  const proxyUrl = String(options.proxyUrl || '').trim();
  const noProxy = String(options.noProxy || '').trim();

  account._lastRefreshAttemptAt = nowMs;
  const refreshTask = (async () => {
    try {
      const body = buildRefreshRequestBody(account);
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
      const nextIdToken = sanitizeAccessToken(payload.id_token || payload.idToken);
      const nextRefreshToken = sanitizeAccessToken(payload.refresh_token || payload.refreshToken);
      const expiresInSec = Number(payload.expires_in || payload.expiresIn || 0);
      const expiresFromDuration = Number.isFinite(expiresInSec) && expiresInSec > 0
        ? nowMs + expiresInSec * 1000
        : null;
      const expiresAt = Number.isFinite(expiresFromDuration)
        ? expiresFromDuration
        : parseJwtExpiryMs(nextAccessToken);

      account.accessToken = nextAccessToken;
      if (nextIdToken) account.idToken = nextIdToken;
      if (nextRefreshToken.startsWith('rt_')) account.refreshToken = nextRefreshToken;
      if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;
      account.lastRefresh = new Date(nowMs).toISOString();

      const persisted = persistCodexAuthSnapshot(account, {
        accessToken: account.accessToken,
        idToken: account.idToken,
        refreshToken: account.refreshToken,
        accountId: account.accountId,
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
  refreshCodexAccessToken,
  __private: {
    sanitizeAccessToken,
    decodeJwtPayloadUnsafe,
    parseIsoTimestampMs,
    parseJwtExpiryMs,
    resolveTokenExpiryMs,
    shouldRefreshToken,
    buildRefreshRequestBody,
    persistCodexAuthSnapshot
  }
};
