'use strict';

function listGrokAuthProfiles(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return [];
  const directToken = String(auth.access_token || auth.accessToken || auth.key || '').trim();
  if (directToken) return [auth];
  return Object.values(auth).filter((profile) => profile && typeof profile === 'object' && !Array.isArray(profile));
}

function parseJwtExpiryMs(token) {
  const text = String(token || '').trim();
  const parts = text.split('.');
  if (parts.length < 2) return null;
  try {
    const rawPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(rawPayload, 'base64').toString('utf8'));
    const expSeconds = Number(payload && payload.exp);
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
    return expSeconds * 1000;
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

function readGrokAuthProfile(auth) {
  for (const profile of listGrokAuthProfiles(auth)) {
    const accessToken = String(profile.access_token || profile.accessToken || profile.key || '').trim();
    const refreshToken = String(profile.refresh_token || profile.refreshToken || '').trim();
    if (!accessToken && !refreshToken) continue;
    const tokenExpiresAt = parseJwtExpiryMs(accessToken)
      || parseIsoTimestampMs(profile.expires_at || profile.expiresAt || profile.expired);
    return {
      accessToken,
      refreshToken,
      email: String(profile.email || '').trim(),
      stableId: String(profile.user_id || profile.principal_id || profile.userId || profile.principalId || '').trim(),
      tokenExpiresAt: Number.isFinite(tokenExpiresAt) && tokenExpiresAt > 0 ? tokenExpiresAt : null
    };
  }
  return { accessToken: '', refreshToken: '', email: '', stableId: '', tokenExpiresAt: null };
}

module.exports = { listGrokAuthProfiles, readGrokAuthProfile };
