'use strict';

function listGrokAuthProfiles(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return [];
  const directToken = String(auth.access_token || auth.accessToken || auth.key || '').trim();
  if (directToken) return [auth];
  return Object.values(auth).filter((profile) => profile && typeof profile === 'object' && !Array.isArray(profile));
}

function readGrokAuthProfile(auth) {
  for (const profile of listGrokAuthProfiles(auth)) {
    const accessToken = String(profile.access_token || profile.accessToken || profile.key || '').trim();
    const refreshToken = String(profile.refresh_token || profile.refreshToken || '').trim();
    if (!accessToken && !refreshToken) continue;
    return {
      accessToken,
      refreshToken,
      email: String(profile.email || '').trim(),
      stableId: String(profile.user_id || profile.principal_id || profile.userId || profile.principalId || '').trim()
    };
  }
  return { accessToken: '', refreshToken: '', email: '', stableId: '' };
}

module.exports = { listGrokAuthProfiles, readGrokAuthProfile };
