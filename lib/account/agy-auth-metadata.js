'use strict';

// The interactive Antigravity CLI writes `auth_method: "consumer"` for personal
// Google OAuth logins and REJECTS any other value with "Unknown auth method" (the
// keyring/browser oauth-param resolver only knows its own enum). aih historically
// hardcoded "oauth" here, which the CLI does not recognise — so an account synced
// through aih would show the login menu despite holding a valid token. Verified on
// the antigravity CLI: "consumer" → "Auth succeeded"; "oauth" → not logged in.
const AGY_CLI_AUTH_METHOD = 'consumer';

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
}

function buildAgyOAuthTokenSnapshot(data, source) {
  try {
    const token = data && data.token && typeof data.token === 'object'
      ? data.token
      : {};
    const accessToken = String(token.access_token || '').trim();
    const refreshToken = String(token.refresh_token || '').trim();
    if (!accessToken && !refreshToken) return null;
    return {
      source,
      authMode: String(data.auth_method || AGY_CLI_AUTH_METHOD).trim() || AGY_CLI_AUTH_METHOD,
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      tokenExpiresAt: parseIsoTimestampMs(token.expiry),
      tokenExpiry: String(token.expiry || '').trim()
    };
  } catch (_error) {
    return null;
  }
}

function isAgyAccessTokenFresh(metadata, nowMs = Date.now(), skewMs = 0) {
  const expiresAt = Number(metadata && metadata.tokenExpiresAt);
  return Boolean(
    metadata
    && metadata.hasAccessToken
    && Number.isFinite(expiresAt)
    && expiresAt > nowMs + Math.max(0, Number(skewMs) || 0)
  );
}

function hasRecoverableAgyOAuthCredentials(metadata, nowMs = Date.now()) {
  return Boolean(
    metadata
    && (
      isAgyAccessTokenFresh(metadata, nowMs)
      || metadata.hasRefreshToken
    )
  );
}

function readAgyEnvToken(credentials) {
  const token = String(
    credentials && (credentials.AGY_ACCESS_TOKEN || credentials.GOOGLE_OAUTH_ACCESS_TOKEN) || ''
  ).trim();
  if (token) return { token, source: 'app-state.db' };
  return { token: '', source: '' };
}

function readAgyAuthMetadata(options = {}) {
  const base = {
    configured: false,
    accountName: 'Unknown',
    email: '',
    authMode: '',
    source: ''
  };
  const credentialRecord = options.credentialRecord || null;
  const nativeAuth = credentialRecord ? credentialRecord.nativeAuth : {};
  const oauthSnapshot = buildAgyOAuthTokenSnapshot(nativeAuth.oauthToken, 'app-state.db');
  if (oauthSnapshot) {
    const email = String(nativeAuth.email || '').trim();
    return {
      configured: true,
      accountName: email || 'OAuth Configured',
      email: email,
      authMode: oauthSnapshot.authMode,
      source: oauthSnapshot.source,
      hasAccessToken: oauthSnapshot.hasAccessToken,
      hasRefreshToken: oauthSnapshot.hasRefreshToken,
      tokenExpiresAt: oauthSnapshot.tokenExpiresAt,
      tokenExpiry: oauthSnapshot.tokenExpiry,
      tokenFresh: isAgyAccessTokenFresh(oauthSnapshot)
    };
  }

  const envToken = readAgyEnvToken(credentialRecord && credentialRecord.env);
  if (envToken.token) {
    const email = String(nativeAuth.email || '').trim();
    return {
      configured: true,
      accountName: email || 'Token Configured',
      email: email,
      authMode: 'access-token',
      source: envToken.source
    };
  }

  return base;
}

module.exports = {
  AGY_CLI_AUTH_METHOD,
  readAgyAuthMetadata,
  isAgyAccessTokenFresh,
  hasRecoverableAgyOAuthCredentials,
  __private: {
    buildAgyOAuthTokenSnapshot,
    parseIsoTimestampMs
  }
};
