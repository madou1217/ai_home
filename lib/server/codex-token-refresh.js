'use strict';


const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { normalizeCodexRefreshToken, resolveCodexWorkspaceFields } = require('../account/codex-auth-metadata');
const {
  readAccountNativeAuth,
  readAccountCredentialRecord,
  compareAndSwapAccountNativeAuth
} = require('./account-credential-store');
const {
  describeAccountEgressFailure,
  resolveProviderAccountEgressRequestOptions
} = require('./account-egress-request-options');
const {
  invalidateCodexAppServerEndpoint: defaultInvalidateCodexAppServerEndpoint
} = require('./codex-app-server-endpoint');

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

function resolveCredentialContext(account, deps = {}) {
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const accountRef = String(account && account.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) return null;
  return { fs: deps.fs || fs, aiHomeDir, accountRef };
}

function persistCodexAuthSnapshot(account, tokens, nowMs, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const snapshot = deps.credentialSnapshot
    || readAccountCredentialRecord(context.fs, context.aiHomeDir, context.accountRef);
  if (!snapshot) return false;
  const nativeAuth = snapshot.nativeAuth;
  const current = nativeAuth.auth;
  const next = current && typeof current === 'object' ? { ...current } : {};
  const currentTokens = next.tokens && typeof next.tokens === 'object' ? { ...next.tokens } : {};

  currentTokens.access_token = String(tokens.accessToken || '');
  if (tokens.idToken) currentTokens.id_token = String(tokens.idToken || '');
  if (tokens.refreshToken) currentTokens.refresh_token = String(tokens.refreshToken || '');
  if (tokens.upstreamAccountId) currentTokens.account_id = String(tokens.upstreamAccountId || '');

  next.tokens = currentTokens;
  next.last_refresh = new Date(nowMs).toISOString();
  if (Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0) {
    next.expired = new Date(tokens.expiresAt).toISOString();
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentRecord = readAccountCredentialRecord(context.fs, context.aiHomeDir, context.accountRef);
    if (!currentRecord || !isDeepStrictEqual(currentRecord.nativeAuth.auth, snapshot.nativeAuth.auth)
      || currentRecord.env.OPENAI_API_KEY) return false;
    if (compareAndSwapAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef, currentRecord, {
      ...currentRecord.nativeAuth, auth: next
    })) return true;
    // A metadata-only writer must not make us lose a successfully rotated grant.
    // Retry with that metadata; never retry across a changed auth generation.
  }
  return false;
}

function reloadAccountTokensFromAuthSnapshot(account, deps = {}) {
  const context = resolveCredentialContext(account, deps);
  if (!context) return false;
  const authJson = readAccountNativeAuth(context.fs, context.aiHomeDir, context.accountRef).auth;
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return false;

  const accessToken = sanitizeAccessToken(tokens.access_token || tokens.accessToken);
  const idToken = sanitizeAccessToken(tokens.id_token || tokens.idToken);
  const refreshToken = normalizeCodexRefreshToken(tokens.refresh_token || tokens.refreshToken);
  account.accessToken = accessToken;
  account.idToken = idToken;
  account.refreshToken = refreshToken;
  // 刷新后按 Go 语义重算工作区：显式值只在 id_token 为个人账号时生效，冲突时不发送工作区头。
  Object.assign(account, resolveCodexWorkspaceFields(authJson));
  const accessPayload = decodeJwtPayloadUnsafe(accessToken);
  if (accessPayload && accessPayload.client_id) account.oauthClientId = String(accessPayload.client_id).trim();

  const expiresAt = parseJwtExpiryMs(accessToken) || parseIsoTimestampMs(authJson.expired);
  if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;
  if (authJson.last_refresh) account.lastRefresh = String(authJson.last_refresh || '');
  return true;
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

  const tokenUrl = String(options.tokenUrl || DEFAULT_OPENAI_OAUTH_TOKEN_URL).trim();
  if (!tokenUrl) {
    return { ok: false, refreshed: false, reason: 'missing_token_url' };
  }

  const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
  account._lastRefreshAttemptAt = nowMs;
  let credentialSnapshot = null;
  const credentialContext = resolveCredentialContext(account, deps);
  const readSnapshot = () => readAccountCredentialRecord(
    credentialContext.fs, credentialContext.aiHomeDir, credentialContext.accountRef
  );
  const superseded = () => {
    if (!credentialSnapshot) return false;
    const current = readSnapshot();
    return !current || Boolean(current.env.OPENAI_API_KEY)
      || !isDeepStrictEqual(current.nativeAuth.auth, credentialSnapshot.nativeAuth.auth);
  };
  const supersededResult = () => {
    reloadAccountTokensFromAuthSnapshot(account, deps);
    return { ok: true, refreshed: false, reason: 'superseded_by_new_credentials' };
  };
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

    credentialSnapshot = readSnapshot();
    if (!credentialSnapshot) return { ok: false, refreshed: false, reason: 'missing_credential_snapshot' };
    const snapshotTokens = credentialSnapshot.nativeAuth.auth && credentialSnapshot.nativeAuth.auth.tokens || {};
    if (normalizeCodexRefreshToken(snapshotTokens.refresh_token || snapshotTokens.refreshToken) !== currentRefreshToken
      || sanitizeAccessToken(snapshotTokens.access_token || snapshotTokens.accessToken) !== account.accessToken) {
      return supersededResult();
    }
    const requestOptionsResult = await resolveProviderAccountEgressRequestOptions({
      account,
      provider: 'codex',
      options,
      deps
    });
    if (superseded()) return supersededResult();
    if (!requestOptionsResult?.ok || !requestOptionsResult.options) {
      return {
        ok: false,
        refreshed: false,
        ...describeAccountEgressFailure(requestOptionsResult)
      };
    }
    const requestOptions = requestOptionsResult.options;

    const body = buildRefreshRequestBody(account);
    const response = await fetchWithTimeout(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body)
    }, timeoutMs, {
      proxyUrl: requestOptions.proxyUrl,
      noProxy: requestOptions.noProxy
    });

    const rawText = await response.text().catch(() => '');
    if (superseded()) return supersededResult();
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
    const nextRefreshToken = normalizeCodexRefreshToken(payload.refresh_token || payload.refreshToken);
    const expiresInSec = Number(payload.expires_in || payload.expiresIn || 0);
    const expiresFromDuration = Number.isFinite(expiresInSec) && expiresInSec > 0
      ? nowMs + expiresInSec * 1000
      : null;
    const expiresAt = Number.isFinite(expiresFromDuration)
      ? expiresFromDuration
      : parseJwtExpiryMs(nextAccessToken);

    const persisted = persistCodexAuthSnapshot(account, {
      accessToken: nextAccessToken,
      idToken: nextIdToken || account.idToken,
      refreshToken: nextRefreshToken || account.refreshToken,
      upstreamAccountId: account.upstreamAccountId,
      expiresAt
    }, nowMs, { ...deps, credentialSnapshot });
    if (!persisted) {
      if (superseded()) return supersededResult();
      return { ok: false, refreshed: false, reason: 'credential_commit_conflict' };
    }
    // Only publish the new runtime generation after its conditional DB commit.
    // A late HTTP response must not replace a concurrent native App login.
    account.accessToken = nextAccessToken;
    if (nextIdToken) account.idToken = nextIdToken;
    if (nextRefreshToken) account.refreshToken = nextRefreshToken;
    if (Number.isFinite(expiresAt) && expiresAt > 0) account.tokenExpiresAt = expiresAt;
    account.lastRefresh = new Date(nowMs).toISOString();
    if (persisted && deps.accountArtifactHooks && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
      deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
        provider: 'codex',
        accountRef: account.accountRef,
        artifactPath: 'app-state.db',
        source: 'token_refresh',
        reason: 'codex_oauth_token_refreshed'
      });
    }
    let runtimeInvalidation = null;
    if (persisted) {
      const invalidateCodexAppServerEndpoint = typeof deps.invalidateCodexAppServerEndpoint === 'function'
        ? deps.invalidateCodexAppServerEndpoint
        : defaultInvalidateCodexAppServerEndpoint;
      try {
        runtimeInvalidation = invalidateCodexAppServerEndpoint({
          aiHomeDir: deps.aiHomeDir,
          accountRef: account.accountRef,
          spawnSyncImpl: deps.spawnSyncImpl
        });
      } catch (error) {
        runtimeInvalidation = {
          ok: false,
          invalidated: false,
          reason: String(error && (error.code || error.message) || 'runtime_invalidation_failed')
        };
      }
    }

    return {
      ok: true,
      refreshed: true,
      reason: 'refreshed',
      expiresAt: Number(account.tokenExpiresAt) || null,
      persisted,
      runtimeInvalidated: Boolean(runtimeInvalidation && runtimeInvalidation.invalidated),
      runtimeInvalidationReason: String(runtimeInvalidation && runtimeInvalidation.reason || '')
    };
  };

  const refreshTask = (async () => {
    try {
      return await doRefresh();
    } catch (error) {
      if (superseded()) return supersededResult();
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
    resolveCredentialContext,
    shouldRefreshToken,
    buildRefreshRequestBody,
    persistCodexAuthSnapshot,
    reloadAccountTokensFromAuthSnapshot
  }
};
