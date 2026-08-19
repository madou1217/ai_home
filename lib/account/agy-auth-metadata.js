'use strict';

// The interactive Antigravity CLI writes `auth_method: "consumer"` for personal
// Google OAuth logins and REJECTS any other value with "Unknown auth method" (the
// keyring/browser oauth-param resolver only knows its own enum). aih historically
// hardcoded "oauth" here, which the CLI does not recognise — so an account synced
// through aih would show the login menu despite holding a valid token. Verified on
// the antigravity CLI: "consumer" → "Auth succeeded"; "oauth" → not logged in.
const AGY_CLI_AUTH_METHOD = 'consumer';
const AGY_GEMINI_OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
}

function readAgyOAuthTokenFields(oauthToken) {
  const token = oauthToken && oauthToken.token && typeof oauthToken.token === 'object'
    ? oauthToken.token
    : oauthToken && typeof oauthToken === 'object'
      ? oauthToken
      : {};
  return {
    accessToken: String(token.access_token || token.accessToken || '').trim(),
    refreshToken: String(token.refresh_token || token.refreshToken || '').trim(),
    tokenType: String(token.token_type || token.tokenType || 'Bearer').trim() || 'Bearer',
    expiryMs: parseIsoTimestampMs(token.expiry || token.expires_at || token.expiresAt),
    idToken: String(token.id_token || token.idToken || '').trim()
  };
}

// Antigravity Desktop 2.x still consumes the generic Gemini OAuth files when
// its HOME is projected. Keep these files derived from the canonical AGY DB
// snapshot; they are compatibility artifacts, not another account truth source.
function buildAgyGeminiOAuthCredentials(oauthToken) {
  const fields = readAgyOAuthTokenFields(oauthToken);
  if (!fields.accessToken && !fields.refreshToken) return null;
  return {
    access_token: fields.accessToken,
    refresh_token: fields.refreshToken,
    token_type: fields.tokenType,
    expiry_date: fields.expiryMs || 0,
    ...(fields.idToken ? { id_token: fields.idToken } : {}),
    scope: AGY_GEMINI_OAUTH_SCOPE
  };
}

function buildAgyGoogleAccounts(email) {
  const active = String(email || '').trim();
  if (!active) return null;
  return { active, old: [] };
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
  AGY_GEMINI_OAUTH_SCOPE,
  AGY_CLI_AUTH_METHOD,
  buildAgyGeminiOAuthCredentials,
  buildAgyGoogleAccounts,
  readAgyAuthMetadata,
  isAgyAccessTokenFresh,
  hasRecoverableAgyOAuthCredentials,
  __private: {
    buildAgyOAuthTokenSnapshot,
    readAgyOAuthTokenFields,
    parseIsoTimestampMs
  }
};
