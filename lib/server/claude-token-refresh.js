'use strict';

const fs = require('node:fs');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('./account-credential-store');
const {
  readResponseJson,
  readResponseText
} = require('./response-body');

// Official claude-code OAuth token endpoint (see claude-code 2.1.88 cli.js:
// TOKEN_URL="https://platform.claude.com/v1/oauth/token"). The legacy
// api.claude.ai/api/oauth/token host no longer responds, so refresh must use
// platform.claude.com with the claude-code client_id + scopes below.
const DEFAULT_CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // gitleaks:allow
const CLAUDE_CODE_OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
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
    .replace(/sk-ant-[a-z0-9_-]+/gi, '[redacted]')
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
  return null;
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

function persistClaudeOAuthSnapshot(account, tokens, nowMs, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const nativeAuth = readAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef);
  const current = nativeAuth.credentials;
  if (!current || typeof current !== 'object') return false;

  const next = { ...current };
  const currentOauth = next.claudeAiOauth || next.claude_ai_oauth || {};
  const nextOauth = { ...currentOauth };

  nextOauth.accessToken = String(tokens.accessToken || '');
  nextOauth.access_token = nextOauth.accessToken;

  if (tokens.refreshToken) {
    nextOauth.refreshToken = String(tokens.refreshToken || '');
    nextOauth.refresh_token = nextOauth.refreshToken;
  }

  nextOauth.lastRefresh = new Date(nowMs).toISOString();
  nextOauth.last_refresh = nextOauth.lastRefresh;

  if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
    nextOauth.expiresAt = tokens.expiresAt;
    nextOauth.expires_at = tokens.expiresAt;
    nextOauth.expiry = new Date(tokens.expiresAt).toISOString();
  }

  next.claudeAiOauth = nextOauth;

  writeAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef, {
    ...nativeAuth,
    credentials: next
  });
  return true;
}

async function refreshClaudeAccessToken(account, options = {}, deps = {}) {
  if (!account || typeof account !== 'object') {
    return { ok: false, refreshed: false, reason: 'invalid_account' };
  }

  const provider = String(account.provider || 'claude').trim().toLowerCase();
  if (provider !== 'claude') {
    return { ok: false, refreshed: false, reason: 'not_claude' };
  }

  const credentialContext = resolveCredentialContext(account, deps);
  if (!credentialContext) {
    return { ok: false, refreshed: false, reason: 'missing_account_ref' };
  }

  const credentials = readAccountNativeAuth(
    credentialContext.fs,
    credentialContext.aiHomeDir,
    credentialContext.accountRef
  ).credentials;
  if (!credentials || typeof credentials !== 'object') {
    return { ok: false, refreshed: false, reason: 'missing_credentials' };
  }

  const oauth = credentials.claudeAiOauth || credentials.claude_ai_oauth;
  if (!oauth || typeof oauth !== 'object') {
    return { ok: false, refreshed: false, reason: 'not_oauth' };
  }

  const refreshToken = String(oauth.refreshToken || oauth.refresh_token || '').trim();
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

  const tokenUrl = String(options.tokenUrl || DEFAULT_CLAUDE_OAUTH_TOKEN_URL).trim();
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
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: String(options.clientId || CLAUDE_CODE_OAUTH_CLIENT_ID),
        scope: String(options.scope || CLAUDE_CODE_OAUTH_SCOPE)
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
            refreshToken,
            account.accessToken
          ])
        };
      }

      const payload = await readResponseJson(response).catch(() => null);
      if (!payload || typeof payload !== 'object') {
        return { ok: false, refreshed: false, reason: 'invalid_refresh_payload' };
      }

      const nextAccessToken = sanitizeAccessToken(payload.access_token || payload.accessToken);
      if (!nextAccessToken) {
        return { ok: false, refreshed: false, reason: 'missing_access_token' };
      }

      const nextRefreshToken = sanitizeAccessToken(payload.refresh_token || payload.refreshToken);
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
      account.lastRefresh = new Date(nowMs).toISOString();

      const persisted = persistClaudeOAuthSnapshot(account, {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.tokenExpiresAt
      }, nowMs, deps);
      if (persisted && deps.accountArtifactHooks && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
        deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
          provider: 'claude',
          accountRef: account.accountRef,
          artifactPath: 'app-state.db',
          source: 'token_refresh',
          reason: 'claude_oauth_token_refreshed'
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
  refreshClaudeAccessToken,
  __private: {
    sanitizeAccessToken,
    decodeJwtPayloadUnsafe,
    parseIsoTimestampMs,
    parseJwtExpiryMs,
    redactKnownOauthSecrets,
    resolveCredentialContext,
    resolveTokenExpiryMs,
    shouldRefreshToken,
    persistClaudeOAuthSnapshot,
    summarizeOauthErrorResponse
  }
};
