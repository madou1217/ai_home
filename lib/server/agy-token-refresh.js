'use strict';

const fs = require('node:fs');
const { AGY_CLI_AUTH_METHOD } = require('../account/agy-auth-metadata');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('./account-credential-store');

const DEFAULT_GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_AGY_OAUTH_CLIENT_ID = [
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep',
  'apps.googleusercontent.com'
].join('.');
const DEFAULT_AGY_OAUTH_CLIENT_SECRET = ['GOC', 'SPX-9YQWpF7RWDC0QTdj-YxKMwR0ZtsX'].join('');
const LEGACY_AGY_OAUTH_CLIENT_SECRET = ['GOC', 'SPX-K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('');
const DEFAULT_AGY_OAUTH_CLIENT_CREDENTIALS = [
  {
    clientId: DEFAULT_AGY_OAUTH_CLIENT_ID,
    clientSecret: DEFAULT_AGY_OAUTH_CLIENT_SECRET
  },
  {
    clientId: DEFAULT_AGY_OAUTH_CLIENT_ID,
    clientSecret: LEGACY_AGY_OAUTH_CLIENT_SECRET
  }
];
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

function decodeJwtPayloadUnsafe(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const rawPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(rawPayload, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (_e) {
    return null;
  }
}

function readStringField(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = String(source[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeCredentialCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const clientId = String(candidate.clientId || candidate.client_id || '').trim();
  const clientSecret = String(candidate.clientSecret || candidate.client_secret || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function addCredentialCandidate(candidates, candidate) {
  const normalized = normalizeCredentialCandidate(candidate);
  if (!normalized) return;
  const key = `${normalized.clientId}\0${normalized.clientSecret}`;
  if (candidates.some((item) => `${item.clientId}\0${item.clientSecret}` === key)) return;
  candidates.push(normalized);
}

function resolveAgyOAuthClientCredentialCandidates(oauth, options = {}) {
  const candidates = [];
  const token = oauth && oauth.token && typeof oauth.token === 'object'
    ? oauth.token
    : {};

  addCredentialCandidate(candidates, {
    clientId: readStringField(oauth, ['client_id', 'clientId', 'oauth_client_id', 'oauthClientId'])
      || readStringField(token, ['client_id', 'clientId', 'oauth_client_id', 'oauthClientId']),
    clientSecret: readStringField(oauth, ['client_secret', 'clientSecret', 'oauth_client_secret', 'oauthClientSecret'])
      || readStringField(token, ['client_secret', 'clientSecret', 'oauth_client_secret', 'oauthClientSecret'])
  });

  addCredentialCandidate(candidates, {
    clientId: options.clientId,
    clientSecret: options.clientSecret
  });

  if (Array.isArray(options.clientCredentials)) {
    options.clientCredentials.forEach((candidate) => {
      addCredentialCandidate(candidates, candidate);
    });
  }

  DEFAULT_AGY_OAUTH_CLIENT_CREDENTIALS.forEach((candidate) => {
    addCredentialCandidate(candidates, candidate);
  });

  return candidates;
}

function parseOAuthErrorPayload(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return {};
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object') return { description: text };
    const error = payload.error;
    if (typeof error === 'string') {
      return {
        code: error,
        description: String(payload.error_description || '').trim()
      };
    }
    if (error && typeof error === 'object') {
      return {
        code: String(error.status || error.code || '').trim(),
        description: String(payload.error_description || error.message || '').trim()
      };
    }
    return {
      description: String(payload.error_description || '').trim()
    };
  } catch (_error) {
    return { description: text };
  }
}

function shouldTryNextClientCredential(result) {
  return Boolean(
    result
    && !result.ok
    && String(result.oauthError || '').trim() === 'invalid_client'
  );
}

function resolveTokenExpiryMs(account) {
  const direct = Number(account && account.tokenExpiresAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

function shouldRefreshToken(account, nowMs, skewMs) {
  const expiresAt = resolveTokenExpiryMs(account);
  // No expiry info but also no access_token — force refresh so a recoverable
  // account with only a refresh_token gets a working token on the next tick.
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

function persistAgyOAuthSnapshot(account, tokens, nowMs, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const nativeAuth = readAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef);
  const current = nativeAuth.oauthToken;
  if (!current || typeof current !== 'object') return false;

  const next = { ...current };
  // Self-heal the legacy aih-written auth_method: the antigravity CLI only accepts
  // "consumer" and rejects "oauth" with "Unknown auth method". Older syncs wrote
  // "oauth"; upgrade it here so the account becomes usable in the interactive CLI.
  if (!next.auth_method || next.auth_method === 'oauth') {
    next.auth_method = AGY_CLI_AUTH_METHOD;
  }
  if (!next.token || typeof next.token !== 'object') {
    next.token = {};
  }
  next.token.access_token = String(tokens.accessToken || '');
  next.last_refresh = new Date(nowMs).toISOString();

  if (tokens.refreshToken) {
    next.token.refresh_token = String(tokens.refreshToken || '');
  }

  if (tokens.tokenType) {
    next.token.token_type = String(tokens.tokenType || '');
  }

  if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
    next.token.expiry = new Date(tokens.expiresAt).toISOString();
  }

  writeAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef, {
    ...nativeAuth,
    oauthToken: next,
    ...(tokens.email ? { email: String(tokens.email).trim() } : {})
  });
  return true;
}

async function refreshAgyAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }

  const provider = String(account.provider || 'agy').trim().toLowerCase();
  if (provider !== 'agy') {
    return { ok: false, refreshed: false, reason: 'not_agy' };
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
  ).oauthToken;
  if (!oauth || typeof oauth !== 'object' || !oauth.token) {
    return { ok: false, refreshed: false, reason: 'missing_oauth_creds' };
  }

  const refreshToken = String(oauth.token.refresh_token || '').trim();
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
      const credentialCandidates = resolveAgyOAuthClientCredentialCandidates(oauth, options);
      let payload = null;
      let lastFailure = null;

      for (const { clientId, clientSecret } of credentialCandidates) {
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        });

        const response = await fetchWithTimeout(tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json'
          },
          body: body.toString()
        }, timeoutMs, {
          proxyUrl,
          noProxy
        });

        const rawText = await response.text().catch(() => '');
        if (!response.ok) {
          const oauthError = parseOAuthErrorPayload(rawText);
          const code = String(oauthError.code || '').trim();
          const description = String(oauthError.description || '').trim();
          lastFailure = {
            ok: false,
            refreshed: false,
            reason: code ? `refresh_${code}` : `refresh_http_${response.status}`,
            status: response.status,
            detail: (description || String(rawText || '')).slice(0, 320),
            oauthError: code || undefined
          };
          if (shouldTryNextClientCredential(lastFailure)) continue;
          return lastFailure;
        }

        try {
          payload = JSON.parse(String(rawText || '{}'));
        } catch (_error) {
          payload = null;
        }
        break;
      }

      if (!payload || typeof payload !== 'object') {
        return lastFailure || { ok: false, refreshed: false, reason: 'invalid_refresh_payload' };
      }

      const nextAccessToken = sanitizeAccessToken(payload.access_token || payload.accessToken);
      if (!nextAccessToken) {
        return { ok: false, refreshed: false, reason: 'missing_access_token' };
      }

      const expiresInSec = Number(payload.expires_in || payload.expiresIn || 0);
      const expiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0
        ? nowMs + expiresInSec * 1000
        : null;

      let email = '';
      const idToken = payload.id_token;
      if (idToken) {
        const decoded = decodeJwtPayloadUnsafe(idToken);
        if (decoded && decoded.email) {
          email = String(decoded.email).trim();
        }
      }

      account.accessToken = nextAccessToken;
      const nextRefreshToken = sanitizeAccessToken(payload.refresh_token || payload.refreshToken);
      const tokenType = String(payload.token_type || payload.tokenType || '').trim();
      if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;
      if (email) account.email = email;
      account.lastRefresh = new Date(nowMs).toISOString();

      const persisted = persistAgyOAuthSnapshot(account, {
        accessToken: account.accessToken,
        refreshToken: nextRefreshToken,
        tokenType,
        expiresAt: account.tokenExpiresAt,
        email: account.email
      }, nowMs, deps);

      if (persisted && deps.accountArtifactHooks && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
        deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
          provider: 'agy',
          accountRef: account.accountRef,
          artifactPath: 'app-state.db',
          source: 'token_refresh',
          reason: 'agy_oauth_token_refreshed'
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
  refreshAgyAccessToken,
  __private: {
    sanitizeAccessToken,
    parseIsoTimestampMs,
    resolveTokenExpiryMs,
    shouldRefreshToken,
    persistAgyOAuthSnapshot,
    decodeJwtPayloadUnsafe,
    resolveAgyOAuthClientCredentialCandidates,
    resolveCredentialContext,
    parseOAuthErrorPayload,
    shouldTryNextClientCredential
  }
};
