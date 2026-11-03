'use strict';

const crypto = require('node:crypto');
const { listGrokAuthProfiles } = require('./grok-auth-profile');
const digest = values => crypto.createHash('sha256').update(values.sort().join('\n')).digest('hex').slice(0, 16);
function aliases(record, keys) {
  const values = keys.map(key => record[key]).filter(value => value != null && value !== '');
  if (values.some(value => typeof value !== 'string' || value !== value.trim() || /[:\s\u0000-\u001f\u007f\ufffd]/u.test(value))) return null;
  const unique = [...new Set(values)];
  return unique.length > 1 ? null : unique[0] || '';
}

// Observed native profiles carry user_id and principal_id alongside display
// email. Prefer a user ID; never manufacture identity from email or credentials.
function buildGrokIdentitySeed(auth) {
  const profiles = listGrokAuthProfiles(auth);
  if (!profiles.length) return '';
  const ids = [];
  for (const profile of profiles) {
    const user = aliases(profile, ['user_id', 'userId']);
    const principal = aliases(profile, ['principal_id', 'principalId']);
    if (user === null || principal === null || (!user && !principal)) return '';
    ids.push(`id:${user || principal}`);
  }
  return `oauth:grok:auth:${digest([...new Set(ids)])}`;
}

// Only the explicit migration planner uses the old vector. It is not a runtime
// fallback, lookup alias, or second identity registration path.
function buildLegacyGrokIdentitySeed(auth, extractedEmail = '') {
  if (extractedEmail) return `oauth:grok:${String(extractedEmail).trim().toLowerCase()}`;
  const ids = listGrokAuthProfiles(auth).flatMap(profile => {
    const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (email) return [`email:${email}`];
    const stable = ['user_id', 'principal_id', 'userId', 'principalId']
      .map(key => typeof profile[key] === 'string' ? profile[key].trim() : '').find(Boolean);
    return stable ? [`id:${stable}`] : [];
  });
  return ids.length ? `oauth:grok:auth:${digest(ids)}` : '';
}
module.exports = { buildGrokIdentitySeed, buildLegacyGrokIdentitySeed };
