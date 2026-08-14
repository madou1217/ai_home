'use strict';

const crypto = require('node:crypto');
const { decodeJwtPayloadUnsafe } = require('./codex-auth-metadata');

const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function hasUsableKimiOAuth(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return false;
  const accessToken = firstNonEmptyString(
    credentials.access_token,
    credentials.accessToken
  );
  const refreshToken = firstNonEmptyString(
    credentials.refresh_token,
    credentials.refreshToken
  );
  return Boolean(accessToken && refreshToken);
}

function readKimiTokenExpiry(credentials) {
  const value = Number(credentials && (
    credentials.expires_at
    || credentials.expiresAt
  ));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

function deriveKimiDeviceId(credentials) {
  const fromToken = firstNonEmptyString(
    credentials && credentials.device_id,
    credentials && credentials.deviceId,
    readKimiTokenClaim(credentials, 'device_id')
  );
  return fromToken || crypto.randomUUID();
}

function readKimiTokenClaim(credentials, claim) {
  if (!credentials || typeof credentials !== 'object') return '';
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

function readKimiTokenSubject(credentials) {
  return firstNonEmptyString(
    credentials && credentials.user_id,
    credentials && credentials.userId,
    credentials && credentials.sub,
    credentials && credentials.subject,
    readKimiTokenClaim(credentials, 'user_id'),
    readKimiTokenClaim(credentials, 'sub')
  );
}

module.exports = {
  KIMI_OAUTH_HOST,
  KIMI_OAUTH_CLIENT_ID,
  hasUsableKimiOAuth,
  readKimiTokenClaim,
  readKimiTokenDeviceId,
  readKimiTokenSubject,
  readKimiTokenExpiry,
  deriveKimiDeviceId
};
