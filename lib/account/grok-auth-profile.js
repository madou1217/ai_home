'use strict';

function listGrokAuthProfileEntries(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return [];
  const directAccessToken = String(auth.access_token || auth.accessToken || auth.key || '').trim();
  const directRefreshToken = String(auth.refresh_token || auth.refreshToken || '').trim();
  if (directAccessToken || directRefreshToken) {
    return [{ key: '', profile: auth }];
  }
  return Object.entries(auth)
    .filter(([, profile]) => profile && typeof profile === 'object' && !Array.isArray(profile))
    .map(([key, profile]) => ({ key, profile }));
}

function listGrokAuthProfiles(auth) {
  return listGrokAuthProfileEntries(auth).map((entry) => entry.profile);
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
  for (const entry of listGrokAuthProfileEntries(auth)) {
    const profile = entry.profile;
    const accessToken = String(profile.access_token || profile.accessToken || profile.key || '').trim();
    const refreshToken = String(profile.refresh_token || profile.refreshToken || '').trim();
    if (!accessToken && !refreshToken) continue;
    const tokenExpiresAt = parseJwtExpiryMs(accessToken)
      || parseIsoTimestampMs(profile.expires_at || profile.expiresAt || profile.expired);
    const profileKey = String(entry.key || '').trim();
    const profileKeyClientId = profileKey.includes('::')
      ? profileKey.slice(profileKey.lastIndexOf('::') + 2).trim()
      : '';
    return {
      accessToken,
      refreshToken,
      email: String(profile.email || '').trim(),
      stableId: String(profile.user_id || profile.principal_id || profile.userId || profile.principalId || '').trim(),
      oauthClientId: String(
        profile.oidc_client_id
        || profile.oidcClientId
        || profile.client_id
        || profile.clientId
        || profileKeyClientId
        || ''
      ).trim(),
      tokenExpiresAt: Number.isFinite(tokenExpiresAt) && tokenExpiresAt > 0 ? tokenExpiresAt : null
    };
  }
  return {
    accessToken: '',
    refreshToken: '',
    email: '',
    stableId: '',
    oauthClientId: '',
    tokenExpiresAt: null
  };
}

module.exports = { listGrokAuthProfiles, readGrokAuthProfile };
