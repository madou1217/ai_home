'use strict';

const crypto = require('node:crypto');
const {
  decodeJwtPayloadUnsafe,
  parseJwtExpiryMs
} = require('./codex-auth-metadata');

const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readRefreshTokenValue(credentials) {
  if (!isRecord(credentials)) return '';
  return firstNonEmptyString(credentials.refresh_token, credentials.refreshToken);
}

function readKimiOAuthCredentials(source) {
  if (!isRecord(source)) return {};
  const credentials = isRecord(source.credentials) ? source.credentials : null;
  const legacyAuth = isRecord(source.auth) ? source.auth : null;
  // 不把两个登录快照的 token 按字段混拼。优先选择可恢复的 canonical
  // 凭据；若它只是迁移过程留下的空壳，则完整回退到 legacy auth。
  if (readRefreshTokenValue(credentials)) return credentials;
  if (readRefreshTokenValue(legacyAuth)) return legacyAuth;
  if (credentials) return credentials;
  if (legacyAuth) return legacyAuth;
  return source;
}

function readKimiAccessToken(source) {
  const credentials = readKimiOAuthCredentials(source);
  return firstNonEmptyString(
    credentials.access_token,
    credentials.accessToken
  );
}

function readKimiRefreshToken(source) {
  const credentials = readKimiOAuthCredentials(source);
  return readRefreshTokenValue(credentials);
}

// Kimi access tokens expire after minutes. A persisted refresh token is the
// durable credential that lets the runtime/daemon recover an access token;
// access-only snapshots are therefore not considered usable accounts.
function hasUsableKimiOAuth(source) {
  return Boolean(readKimiRefreshToken(source));
}

function readKimiTokenExpiry(source) {
  const credentials = readKimiOAuthCredentials(source);
  const values = credentials
    ? [credentials.expires_at, credentials.expiresAt]
    : [];
  let value = 0;
  for (const candidate of values) {
    const number = Number(candidate);
    if (Number.isFinite(number) && number > 0) {
      value = number;
      break;
    }
  }
  if (Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  return parseJwtExpiryMs(readKimiAccessToken(credentials)) || 0;
}

function deriveKimiDeviceId(source) {
  return resolveKimiOAuthDeviceId(source) || crypto.randomUUID();
}

function readKimiTokenClaim(source, claim) {
  const credentials = readKimiOAuthCredentials(source);
  const direct = firstNonEmptyString(
    credentials[claim],
    credentials[claim === 'device_id' ? 'deviceId' : claim]
  );
  if (direct) return direct;

  for (const token of [credentials.access_token, credentials.accessToken, credentials.refresh_token, credentials.refreshToken]) {
    const payload = decodeJwtPayloadUnsafe(token);
    const value = firstNonEmptyString(payload && payload[claim], payload && payload[claim === 'device_id' ? 'deviceId' : claim]);
    if (value) return value;
  }
  return '';
}

function readKimiTokenDeviceId(credentials) {
  return readKimiTokenClaim(credentials, 'device_id');
}

function resolveKimiOAuthDeviceId(source, ...fallbacks) {
  const credentials = readKimiOAuthCredentials(source);
  return firstNonEmptyString(
    readKimiTokenDeviceId(credentials),
    isRecord(source) && source.deviceId,
    isRecord(source) && source.device_id,
    ...fallbacks
  );
}

function readKimiTokenSubject(source) {
  const credentials = readKimiOAuthCredentials(source);
  return firstNonEmptyString(
    credentials && credentials.user_id,
    credentials && credentials.userId,
    credentials && credentials.sub,
    credentials && credentials.subject,
    readKimiTokenClaim(credentials, 'user_id'),
    readKimiTokenClaim(credentials, 'sub')
  );
}

function formatKimiOAuthAccountName(source, accountRef) {
  const credentials = readKimiOAuthCredentials(source);
  const subject = readKimiTokenSubject(credentials);
  if (subject) return `Kimi OAuth: ${subject.slice(0, 4)}...${subject.slice(-4)}`;
  const email = firstNonEmptyString(credentials.email);
  if (email) return email;
  const shortRef = firstNonEmptyString(accountRef).slice(-8);
  return shortRef ? `Kimi OAuth (${shortRef})` : 'Kimi OAuth';
}

module.exports = {
  KIMI_OAUTH_HOST,
  KIMI_OAUTH_CLIENT_ID,
  formatKimiOAuthAccountName,
  readKimiOAuthCredentials,
  readKimiAccessToken,
  readKimiRefreshToken,
  hasUsableKimiOAuth,
  readKimiTokenClaim,
  readKimiTokenDeviceId,
  readKimiTokenSubject,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId,
  deriveKimiDeviceId
};
