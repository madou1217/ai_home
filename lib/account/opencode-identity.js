'use strict';

const {
  canonicalSubject, consistentSubject, digestSubject, hasNativeSecret,
  readSubjectAliases, tokenSubject
} = require('./identity-subject');

/**
 * An OpenCode auth file is a set of upstream grants, not one display email.
 * Every entry must contribute a verifiable identity; dropping an unknown entry
 * would make a partial document alias another user's complete document.
 */
function buildOpenCodeIdentitySeed(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  const entries = Object.entries(auth);
  if (!entries.length || entries.length > 256) return '';
  const identities = [];
  const names = new Set();
  for (const [rawName, record] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!canonicalSubject(name) || names.has(name) || !record || typeof record !== 'object' || Array.isArray(record)) return '';
    names.add(name);
    // Empty native placeholders are not grants; partially populated grants are.
    if (Object.keys(record).length === 0) continue;
    const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    const keyNames = ['key', 'apiKey', 'api_key', 'access_key'];
    if (type === 'api' || type === 'api-key' || (!type && hasNativeSecret(record, keyNames))) {
      const keys = [...new Set(keyNames.map(key => record[key]).filter(value => value !== undefined && value !== ''))];
      if (keys.length !== 1 || !hasNativeSecret(record, keyNames)) return '';
      // This is a genuine static-key identity, not an OAuth token fallback.
      identities.push(`${name}:${type || 'unknown'}:key:${digestSubject(keys[0])}`);
      continue;
    }
    if (type !== 'oauth' || !hasNativeSecret(record, ['access', 'access_token', 'refresh', 'refresh_token'])) return '';
    const subject = consistentSubject([
      readSubjectAliases(record, ['account_id', 'accountId', 'user_id', 'userId', 'id', 'uuid']),
      tokenSubject(record.access || record.access_token),
      tokenSubject(record.refresh || record.refresh_token)
    ]);
    if (!subject) return '';
    identities.push(`${name}:${type}:id:${subject}`);
  }
  if (!identities.length) return '';
  identities.sort();
  return `oauth:opencode:auth:${digestSubject(identities.join('\n'))}`;
}

module.exports = { buildOpenCodeIdentitySeed };
