'use strict';

function normalizeRuntimeAuthMode(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (raw === 'api-key' || raw === 'apikey') return 'api-key';
  if (raw === 'auth-token' || raw === 'authtoken' || raw === 'claude-code-token') return 'auth-token';
  if (raw === 'oauth' || raw === 'oauth-browser' || raw === 'oauth-device') return raw;
  return '';
}

function resolveRuntimeAuthMode(account) {
  const explicit = normalizeRuntimeAuthMode(
    account && (account.credentialType || account.authMode || account.authType)
  );
  if (explicit === 'auth-token') return explicit;
  if (account && account.apiKeyMode) return 'api-key';
  return explicit;
}

function isApiCredentialAuthMode(authMode) {
  const normalized = normalizeRuntimeAuthMode(authMode);
  return normalized === 'api-key' || normalized === 'auth-token';
}

function isApiCredentialAccount(account) {
  return isApiCredentialAuthMode(resolveRuntimeAuthMode(account));
}

module.exports = {
  isApiCredentialAccount,
  isApiCredentialAuthMode,
  normalizeRuntimeAuthMode,
  resolveRuntimeAuthMode
};
