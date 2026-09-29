'use strict';

// Registration dedupes by `acct_` + sha256('unique:' + seed). Accounts created
// under an older seed rule keep their old accountRef, so a fresh registration of
// the same credential derives a different ref and silently duplicates the
// account. This module closes that gap: it re-derives the identity seed of each
// stored account of the provider with the *current* rules and returns the
// existing accountRef whose credentials resolve to the same identity.

const { buildApiKeyIdentity } = require('./transfer-core');
const {
  normalizeIdentitySeed,
  resolveNativeAuthIdentitySeed
} = require('./account-identity');

function parseObject(text) {
  try {
    const value = JSON.parse(String(text || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_error) {
    return {};
  }
}

function isSecretSeed(identitySeed) {
  return identitySeed.startsWith('api_key:') || identitySeed.startsWith('auth_token:');
}

function deriveStoredIdentitySeed(provider, identitySeed, row) {
  if (isSecretSeed(identitySeed)) {
    return normalizeIdentitySeed(buildApiKeyIdentity(provider, { config: parseObject(row.env_json) }));
  }
  const resolved = resolveNativeAuthIdentitySeed(provider, parseObject(row.native_auth_json));
  return resolved && !resolved.degraded ? resolved.identitySeed : '';
}

function hasCredentialTable(db) {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_credentials'"
  ).get());
}

/**
 * @returns {string} accountRef of a stored account with the same identity, or ''.
 */
function findAccountRefByIdentity(db, { provider, identitySeed, excludeAccountRef = '' }) {
  if (!db || !provider || !identitySeed || !hasCredentialTable(db)) return '';
  const rows = db.prepare(`
    SELECT r.account_ref, c.env_json, c.native_auth_json
    FROM account_refs r
    JOIN account_credentials c ON c.account_ref = r.account_ref
    WHERE r.provider = ? AND r.account_ref <> ?
    ORDER BY r.created_at ASC
  `).all(provider, excludeAccountRef);
  for (const row of rows) {
    let storedSeed = '';
    try {
      storedSeed = deriveStoredIdentitySeed(provider, identitySeed, row);
    } catch (_error) {
      storedSeed = '';
    }
    if (storedSeed && storedSeed === identitySeed) return String(row.account_ref);
  }
  return '';
}

module.exports = {
  findAccountRefByIdentity
};
