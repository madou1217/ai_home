'use strict';

const IDENTITY_FIELDS = Object.freeze([
  'email',
  'emailAddress',
  'email_address',
  'username',
  'displayName',
  'display_name',
  'fullName',
  'full_name',
  'name',
  'id',
  'uuid'
]);

const IDENTITY_OBJECT_FIELDS = Object.freeze([
  'account',
  'accountInfo',
  'account_info',
  'user',
  'profile'
]);

const KEY_PROVIDER_PRIORITY = Object.freeze([
  'opencode-go',
  'openai',
  'anthropic',
  'google',
  'codex'
]);

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readOpenCodeAuthProviders(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return [];
  return Object.entries(auth)
    .filter(([, value]) => value && typeof value === 'object' && hasNonEmptyString(value.type))
    .map(([provider]) => String(provider || '').trim())
    .filter(Boolean)
    .sort();
}

function pickIdentityFromObject(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  for (const field of IDENTITY_FIELDS) {
    const value = source[field];
    if (hasNonEmptyString(value)) return value.trim();
  }
  return '';
}

function pickOpenCodeAccountIdentity(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  for (const value of Object.values(auth)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const direct = pickIdentityFromObject(value);
    if (direct) return direct;
    for (const field of IDENTITY_OBJECT_FIELDS) {
      const nested = pickIdentityFromObject(value[field]);
      if (nested) return nested;
    }
  }
  return '';
}

function maskKeyFingerprint(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  const suffix = key.slice(-4);
  return `...${suffix.padStart(4, '*')}`;
}

function findOpenCodeKeyFingerprint(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const providers = readOpenCodeAuthProviders(auth);
  const orderedProviders = Array.from(new Set([
    ...KEY_PROVIDER_PRIORITY,
    ...providers
  ]));
  for (const provider of orderedProviders) {
    const value = auth[provider];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const fingerprint = maskKeyFingerprint(value.key);
    if (fingerprint) {
      return { provider, fingerprint };
    }
  }
  return null;
}

function formatOpenCodeFallbackName(auth, accountRef = '') {
  const key = findOpenCodeKeyFingerprint(auth);
  if (key) {
    return key.provider === 'opencode-go'
      ? `OpenCode Go API (${key.fingerprint})`
      : `OpenCode API (${key.fingerprint})`;
  }
  const suffix = String(accountRef || '').trim();
  return suffix ? `OpenCode Account ${suffix}` : 'OpenCode Account';
}

function summarizeOpenCodeAuth(auth, options = {}) {
  const providers = readOpenCodeAuthProviders(auth);
  if (providers.length < 1) {
    return {
      configured: false,
      accountName: 'Unknown',
      authMode: '',
      providers
    };
  }
  const identity = pickOpenCodeAccountIdentity(auth);
  return {
    configured: true,
    accountName: identity || formatOpenCodeFallbackName(auth, options.accountRef),
    authMode: 'opencode-auth',
    providers
  };
}

module.exports = {
  formatOpenCodeFallbackName,
  pickOpenCodeAccountIdentity,
  readOpenCodeAuthProviders,
  summarizeOpenCodeAuth
};
