'use strict';

const OAUTH_PENDING_FALLBACK_STALE_MS = 5 * 60 * 1000;

function normalizeAuthMode(value) {
  return String(value || '').trim().toLowerCase();
}

function isOauthAuthMode(value) {
  const authMode = normalizeAuthMode(value);
  return authMode === 'oauth'
    || authMode === 'oauth-browser'
    || authMode === 'oauth-device'
    || authMode === 'device'
    || authMode === 'device-code';
}

function resolveOauthPendingState(values = {}) {
  const configured = Boolean(values.configured);
  const apiKeyMode = Boolean(values.apiKeyMode);
  const authMode = normalizeAuthMode(values.authMode);
  const pending = Boolean(!configured && !apiKeyMode && isOauthAuthMode(authMode));
  if (!pending) {
    return {
      pending: false,
      stale: false,
      ageMs: 0,
      staleMs: OAUTH_PENDING_FALLBACK_STALE_MS
    };
  }

  const nowMs = Number.isFinite(values.nowMs) ? values.nowMs : Date.now();
  const updatedAt = Number(values.updatedAt) || 0;
  const staleMs = Number.isFinite(values.staleMs) && values.staleMs > 0
    ? values.staleMs
    : OAUTH_PENDING_FALLBACK_STALE_MS;
  const ageMs = updatedAt > 0 ? Math.max(0, nowMs - updatedAt) : staleMs;

  return {
    pending: true,
    stale: ageMs >= staleMs,
    ageMs,
    staleMs
  };
}

function resolveOauthJobDeadline(job, staleMs = OAUTH_PENDING_FALLBACK_STALE_MS) {
  if (!job) return 0;
  const expiresAt = Number(job.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  const createdAt = Number(job.createdAt) || 0;
  if (!createdAt) return 0;
  const ttl = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : OAUTH_PENDING_FALLBACK_STALE_MS;
  return createdAt + ttl;
}

module.exports = {
  OAUTH_PENDING_FALLBACK_STALE_MS,
  isOauthAuthMode,
  resolveOauthPendingState,
  resolveOauthJobDeadline
};
