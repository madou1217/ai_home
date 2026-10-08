'use strict';

const { createKiroIdentityEvidence } = require('./kiro-identity');
const { fetchKiroUsageLimits } = require('./kiro-usage-client');

// Enrollment and quota refresh share the verified AWS wire contract.
// Only userInfo.userId establishes identity; email/plan remain display data.
async function resolveKiroIdentityEvidence(nativeAuth, options = {}) {
  const document = await fetchKiroUsageLimits(nativeAuth, options);
  const evidence = createKiroIdentityEvidence(nativeAuth.auth, document, (options.now || Date.now)());
  if (!evidence) throw Object.assign(new Error('kiro_identity_unverifiable'), { code: 'kiro_identity_unverifiable' });
  return evidence;
}

module.exports = { resolveKiroIdentityEvidence };
