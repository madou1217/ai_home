'use strict';

const CLAUDE_CREDENTIAL_TYPES = Object.freeze({
  API_KEY: 'api-key',
  AUTH_TOKEN: 'auth-token'
});

const CLAUDE_CREDENTIAL_TYPE_ENV = 'AIH_CLAUDE_CREDENTIAL_TYPE';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEpochMilliseconds(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readClaudeOauthCredential(nativeAuth = {}, options = {}) {
  const credentials = nativeAuth.credentials && typeof nativeAuth.credentials === 'object'
    ? nativeAuth.credentials
    : {};
  const oauth = credentials.claudeAiOauth || credentials.claude_ai_oauth || {};
  const accessToken = normalizeString(oauth.accessToken || oauth.access_token);
  const refreshToken = normalizeString(oauth.refreshToken || oauth.refresh_token);
  const expiresAt = [oauth.expiresAt, oauth.expires_at, oauth.expiry]
    .map(normalizeEpochMilliseconds)
    .find((value) => value > 0) || 0;
  const requestedNow = typeof options.nowMs === 'function' ? options.nowMs() : options.nowMs;
  const nowMs = Number.isFinite(Number(requestedNow)) ? Number(requestedNow) : Date.now();
  const expired = Boolean(accessToken && expiresAt > 0 && expiresAt <= nowMs);
  return {
    oauth,
    accessToken,
    refreshToken,
    expiresAt,
    expired,
    configured: Boolean(accessToken) && (!expired || Boolean(refreshToken))
  };
}

function normalizeClaudeCredentialType(value) {
  const raw = normalizeString(value).toLowerCase().replace(/_/g, '-');
  if (raw === 'api-key' || raw === 'apikey') return CLAUDE_CREDENTIAL_TYPES.API_KEY;
  if (
    raw === 'auth-token'
    || raw === 'authtoken'
    || raw === 'anthropic-auth-token'
    || raw === 'claude-code-token'
    || raw === 'claude-auth-token'
  ) {
    return CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN;
  }
  return '';
}

function getClaudeCredentialType(input = {}) {
  const explicit = normalizeClaudeCredentialType(input.credentialType || input.authMode || input.authType);
  if (explicit) return explicit;

  const env = input.env && typeof input.env === 'object' ? input.env : {};
  const settingsEnv = input.settingsEnv && typeof input.settingsEnv === 'object' ? input.settingsEnv : {};
  const envType = normalizeClaudeCredentialType(
    env[CLAUDE_CREDENTIAL_TYPE_ENV] || settingsEnv[CLAUDE_CREDENTIAL_TYPE_ENV]
  );
  if (envType) return envType;

  if (normalizeString(env.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
    return CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN;
  }
  if (normalizeString(env.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY)) {
    return CLAUDE_CREDENTIAL_TYPES.API_KEY;
  }
  return '';
}

function readClaudeCredential(input = {}) {
  const env = input.env && typeof input.env === 'object' ? input.env : {};
  const settingsEnv = input.settingsEnv && typeof input.settingsEnv === 'object' ? input.settingsEnv : {};
  const credentialType = getClaudeCredentialType(input);
  const apiKey = normalizeString(env.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY);
  const authToken = normalizeString(env.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_AUTH_TOKEN);
  const token = credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN
    ? authToken
    : apiKey || authToken;
  const baseUrl = normalizeString(env.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_BASE_URL);
  return {
    credentialType,
    token,
    apiKey,
    authToken,
    baseUrl,
    configured: Boolean(token)
  };
}

function writeClaudeCredentialEnv(env, input = {}) {
  const out = env && typeof env === 'object' ? { ...env } : {};
  const credentialType = normalizeClaudeCredentialType(input.credentialType) || CLAUDE_CREDENTIAL_TYPES.API_KEY;
  const token = normalizeString(input.token);
  const baseUrl = normalizeString(input.baseUrl);

  if (credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN) {
    out[CLAUDE_CREDENTIAL_TYPE_ENV] = credentialType;
    delete out.ANTHROPIC_API_KEY;
    if (token) out.ANTHROPIC_AUTH_TOKEN = token;
  } else {
    delete out[CLAUDE_CREDENTIAL_TYPE_ENV];
    delete out.ANTHROPIC_AUTH_TOKEN;
    if (token) out.ANTHROPIC_API_KEY = token;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'baseUrl')) {
    if (baseUrl) out.ANTHROPIC_BASE_URL = baseUrl;
    else delete out.ANTHROPIC_BASE_URL;
  }

  return out;
}

function isClaudeAuthTokenAccount(account) {
  return getClaudeCredentialType(account || {}) === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN;
}

module.exports = {
  CLAUDE_CREDENTIAL_TYPES,
  CLAUDE_CREDENTIAL_TYPE_ENV,
  getClaudeCredentialType,
  isClaudeAuthTokenAccount,
  normalizeClaudeCredentialType,
  readClaudeOauthCredential,
  readClaudeCredential,
  writeClaudeCredentialEnv
};
