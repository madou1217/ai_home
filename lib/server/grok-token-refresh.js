'use strict';

const fs = require('node:fs');
const { listGrokAuthProfiles } = require('../account/grok-auth-profile');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('./account-credential-store');
const {
  readResponseJson,
  readResponseText
} = require('./response-body');

const DEFAULT_XAI_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const DEFAULT_GROK_OIDC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 30_000;

function sanitizeAccessToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

function redactKnownOauthSecrets(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const normalized = String(secret || '').trim();
    if (normalized) text = text.split(normalized).join('[redacted]');
  }
  return text
    .replace(/xai-[a-z0-9_-]+/gi, '[redacted]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[redacted]')
    .replace(/[\r\n\0\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeOauthErrorResponse(rawText, secrets = []) {
  let payload;
  try {
    payload = JSON.parse(String(rawText || '').slice(0, 16 * 1024));
  } catch (_error) {
    return 'oauth_token_endpoint_error';
  }
  if (!payload || typeof payload !== 'object') return 'oauth_token_endpoint_error';
  const rawCode = typeof payload.error === 'string'
    ? payload.error
    : String(payload.error && (payload.error.code || payload.error.type) || '');
  const safeCode = redactKnownOauthSecrets(rawCode, secrets);
  const errorCode = !safeCode.includes('[redacted]') && /^[a-z0-9_.:-]{1,80}$/i.test(safeCode)
    ? safeCode
    : 'oauth_token_endpoint_error';
  const description = redactKnownOauthSecrets(
    payload.error_description || payload.errorDescription || payload.message || '',
    secrets
  ).slice(0, 240);
  return description ? `${errorCode}: ${description}` : errorCode;
}

function decodeJwtPayloadUnsafe(jwt) {
  const text = String(jwt || '').trim();
  const parts = text.split('.');
  if (parts.length < 2) return null;
  try {
    const rawPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(rawPayload, 'base64').toString('utf8'));
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
  return parseJwtExpiryMs(account && account.accessToken);
}

function shouldRefreshToken(account, nowMs, skewMs) {
  const expiresAt = resolveTokenExpiryMs(account);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - nowMs <= skewMs;
}

function resolveCredentialContext(account, deps = {}) {
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const accountRef = String(account && account.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) return null;
  return { fs: deps.fs || fs, aiHomeDir, accountRef };
}

function readGrokProfileKey(authJson) {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) return '';
  for (const key of Object.keys(authJson)) {
    const profile = authJson[key];
    if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
      if (profile.key || profile.access_token || profile.accessToken || profile.refresh_token || profile.refreshToken) {
        return key;
      }
    }
  }
  return '';
}

function persistGrokOAuthSnapshot(account, tokens, nowMs, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const nativeAuth = readAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef);
  const currentAuth = nativeAuth.auth;
  if (!currentAuth || typeof currentAuth !== 'object') return false;

  const nextAuth = { ...currentAuth };
  const profileKey = readGrokProfileKey(currentAuth);

  if (profileKey && typeof currentAuth[profileKey] === 'object') {
    const currentProfile = { ...currentAuth[profileKey] };
    currentProfile.key = String(tokens.accessToken || '');
    if (tokens.refreshToken) {
      currentProfile.refresh_token = String(tokens.refreshToken || '');
    }
    if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
      currentProfile.expires_at = new Date(tokens.expiresAt).toISOString();
    }
    nextAuth[profileKey] = currentProfile;
  } else {
    // Top-level direct profile format fallback
    nextAuth.access_token = String(tokens.accessToken || '');
    nextAuth.key = nextAuth.access_token;
    if (tokens.refreshToken) {
      nextAuth.refresh_token = String(tokens.refreshToken || '');
    }
    if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
      nextAuth.expires_at = new Date(tokens.expiresAt).toISOString();
    }
  }

  writeAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef, {
    ...nativeAuth,
    auth: nextAuth
  });
  return true;
}

function reloadAccountTokensFromAuthSnapshot(account, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const authJson = readAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef).auth;
  if (!authJson || typeof authJson !== 'object') return false;

  const profiles = listGrokAuthProfiles(authJson);
  for (const profile of profiles) {
    const accessToken = sanitizeAccessToken(profile.access_token || profile.accessToken || profile.key);
    const refreshToken = sanitizeAccessToken(profile.refresh_token || profile.refreshToken);
    if (!accessToken && !refreshToken) continue;

    if (accessToken) account.accessToken = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    const expiresAt = parseJwtExpiryMs(accessToken) || parseIsoTimestampMs(profile.expires_at || profile.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;
    if (profile.email) account.email = String(profile.email).trim();
    return true;
  }
  return false;
}

function resolveGrokOauthClientId(account) {
  const accountClientId = String(account && account.oauthClientId || '').trim();
  if (accountClientId) return accountClientId;
  const accessTokenPayload = decodeJwtPayloadUnsafe(account && account.accessToken);
  const payloadClientId = String(
    accessTokenPayload
    && (accessTokenPayload.client_id || accessTokenPayload.aud)
    || ''
  ).trim();
  return payloadClientId || DEFAULT_GROK_OIDC_CLIENT_ID;
}

async function refreshGrokAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }

  const provider = String(account.provider || 'grok').trim().toLowerCase();
  if (provider !== 'grok') {
    return { ok: false, refreshed: false, reason: 'not_grok' };
  }

  const isApiKey = Boolean(account.apiKeyMode || account.authType === 'api-key');
  if (isApiKey) {
    return { ok: false, refreshed: false, reason: 'not_oauth' };
  }

  const originalRefreshToken = String(account.refreshToken || '').trim();
  if (!resolveCredentialContext(account, deps)) {
    return { ok: false, refreshed: false, reason: 'missing_account_ref' };
  }
  reloadAccountTokensFromAuthSnapshot(account, deps);
  const refreshToken = String(account.refreshToken || '').trim();
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

  const tokenUrl = String(options.tokenUrl || DEFAULT_XAI_OAUTH_TOKEN_URL).trim();
  if (!tokenUrl) {
    return { ok: false, refreshed: false, reason: 'missing_token_url' };
  }

  const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
  const proxyUrl = String(options.proxyUrl || '').trim();
  const noProxy = String(options.noProxy || '').trim();

  account._lastRefreshAttemptAt = nowMs;
  const doRefresh = async () => {
    reloadAccountTokensFromAuthSnapshot(account, deps);
    const currentRefreshToken = String(account.refreshToken || '').trim();
    if (!currentRefreshToken) {
      return { ok: false, refreshed: false, reason: 'missing_refresh_token' };
    }
    const rotatedElsewhere = (originalRefreshToken && currentRefreshToken !== originalRefreshToken)
      || currentRefreshToken !== refreshToken;
    if (rotatedElsewhere && !shouldRefreshToken(account, nowMs, skewMs)) {
      return {
        ok: true,
        refreshed: false,
        reason: 'already_refreshed',
        expiresAt: Number(account.tokenExpiresAt) || null
      };
    }

    const clientId = resolveGrokOauthClientId(account);
    const body = {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: currentRefreshToken
    };

    const response = await fetchWithTimeout(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'identity'
      },
      body: JSON.stringify(body)
    }, timeoutMs, {
      proxyUrl,
      noProxy
    });

    if (!response.ok) {
      const rawText = await readResponseText(response).catch(() => '');
      return {
        ok: false,
        refreshed: false,
        reason: `refresh_http_${response.status}`,
        status: response.status,
        detail: summarizeOauthErrorResponse(rawText, [
          currentRefreshToken,
          account.accessToken
        ])
      };
    }

    const payload = await readResponseJson(response).catch(() => null);
    if (!payload || typeof payload !== 'object') {
      return { ok: false, refreshed: false, reason: 'invalid_refresh_payload' };
    }

    const nextAccessToken = sanitizeAccessToken(payload.access_token || payload.accessToken || payload.key);
    if (!nextAccessToken) {
      return { ok: false, refreshed: false, reason: 'missing_access_token' };
    }

    const nextRefreshToken = sanitizeAccessToken(payload.refresh_token || payload.refreshToken) || currentRefreshToken;
    const expiresInSec = Number(payload.expires_in || payload.expiresIn || 0);
    const expiresFromDuration = Number.isFinite(expiresInSec) && expiresInSec > 0
      ? nowMs + expiresInSec * 1000
      : null;
    const expiresAt = Number.isFinite(expiresFromDuration)
      ? expiresFromDuration
      : parseJwtExpiryMs(nextAccessToken);

    account.accessToken = nextAccessToken;
    if (nextRefreshToken) account.refreshToken = nextRefreshToken;
    if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;

    const persisted = persistGrokOAuthSnapshot(account, {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.tokenExpiresAt
    }, nowMs, deps);

    if (persisted && deps.accountArtifactHooks && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
      deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
        provider: 'grok',
        accountRef: account.accountRef,
        artifactPath: 'app-state.db',
        source: 'token_refresh',
        reason: 'grok_oauth_token_refreshed'
      });
    }

    return {
      ok: true,
      refreshed: true,
      reason: 'refreshed',
      expiresAt: Number(account.tokenExpiresAt) || null,
      persisted
    };
  };

  const refreshTask = (async () => {
    try {
      return await doRefresh();
    } catch (error) {
      return {
        ok: false,
        refreshed: false,
        reason: 'refresh_exception',
        detail: redactKnownOauthSecrets(
          String((error && error.message) || error || ''),
          [refreshToken, account.accessToken]
        ).slice(0, 320)
      };
    } finally {
      account._refreshPromise = null;
    }
  })();

  account._refreshPromise = refreshTask;
  return refreshTask;
}

module.exports = {
  refreshGrokAccessToken,
  DEFAULT_XAI_OAUTH_TOKEN_URL,
  DEFAULT_GROK_OIDC_CLIENT_ID,
  __private: {
    sanitizeAccessToken,
    decodeJwtPayloadUnsafe,
    parseIsoTimestampMs,
    parseJwtExpiryMs,
    redactKnownOauthSecrets,
    resolveTokenExpiryMs,
    shouldRefreshToken,
    resolveCredentialContext,
    readGrokProfileKey,
    persistGrokOAuthSnapshot,
    reloadAccountTokensFromAuthSnapshot,
    resolveGrokOauthClientId,
    summarizeOauthErrorResponse
  }
};
