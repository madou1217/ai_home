'use strict';

function normalizeTokenRefreshFailureReason(result) {
  const reason = String(result && result.reason || 'refresh_failed')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80);
  return reason || 'refresh_failed';
}

const UNRECOVERABLE_REFRESH_TOKEN_CODES = new Set([
  'expired_refresh_token',
  'invalid_grant',
  'invalid_refresh_token',
  'refresh_token_expired',
  'refresh_token_invalid',
  'refresh_token_not_found',
  'refresh_token_revoked',
  'revoked_refresh_token'
]);

function normalizeRefreshFailureCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasUnrecoverableRefreshTokenEvidence(result) {
  const fields = [
    result && result.reason,
    result && result.oauthError,
    result && result.code,
    result && result.detail
  ];
  if (fields.some((value) => UNRECOVERABLE_REFRESH_TOKEN_CODES.has(normalizeRefreshFailureCode(value)))) {
    return true;
  }

  const evidence = fields.map((value) => String(value || '')).join(' ').toLowerCase();
  if (/(?:^|[^a-z0-9])invalid_grant(?:[^a-z0-9]|$)/.test(evidence)) return true;
  return /refresh[ _-]?token[ _:"'=,-]*(?:(?:is|was|has been)[ _-]+)?(?:invalid|expired|revoked|not found|no longer valid)/.test(evidence)
    || /(?:invalid|expired|revoked)(?:[ _-]+or[ _-]+(?:invalid|expired|revoked))*[ _-]+(?:the[ _-]+)?refresh[ _-]?token/.test(evidence);
}

function isUnrecoverableTokenRefreshFailure(result) {
  if (!result || result.ok) return false;
  if (String(result.reason || '') === 'missing_refresh_token') return true;
  return hasUnrecoverableRefreshTokenEvidence(result);
}

module.exports = {
  isUnrecoverableTokenRefreshFailure,
  normalizeTokenRefreshFailureReason
};
