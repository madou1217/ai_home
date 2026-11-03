'use strict';

const { snapshotKiroCredentialVersions } = require('./kiro-credential-version');
const { kiroTokenBinding } = require('./kiro-identity');
const { resolveKiroIdentityEvidence } = require('./kiro-identity-probe');
const { readProviderAuthProjection, registerProviderAuthProjection, captureProviderAuth } = require('./native-auth-projection');

/**
 * Resolve identity before naming an account, and compare the native snapshot
 * again after the asynchronous request. No token-only intermediate account is
 * created, so failed/cancelled verification cannot leave an unstable accountRef.
 */
async function prepareKiroIdentityProjection(fs, runtimeDir, options = {}) {
  const expectedKiroVersions = snapshotKiroCredentialVersions(fs, options.aiHomeDir);
  const readProjection = options.readProjection || readProviderAuthProjection;
  const projection = readProjection(fs, runtimeDir, 'kiro', options);
  const before = kiroTokenBinding(projection.auth);
  if (!before) throw Object.assign(new Error('kiro_identity_missing_access_token'), { code: 'kiro_identity_missing_access_token' });
  const resolveEvidence = options.resolveEvidence || resolveKiroIdentityEvidence;
  const evidence = await resolveEvidence(projection, options);
  const current = readProjection(fs, runtimeDir, 'kiro', options);
  if (kiroTokenBinding(current.auth) !== before || evidence.tokenBinding !== before) {
    throw Object.assign(new Error('kiro_identity_credential_changed'), { code: 'kiro_identity_credential_changed' });
  }
  return { projectionMetadata: { identityEvidence: evidence }, expectedKiroVersions };
}

async function registerKiroNativeLogin(fs, runtimeDir, options = {}) {
  try {
    const verification = await prepareKiroIdentityProjection(fs, runtimeDir, options);
    return registerProviderAuthProjection(fs, runtimeDir, 'kiro', { ...options, ...verification });
  } catch (error) {
    return { registered: false, reason: error?.code || 'kiro_identity_unverifiable' };
  }
}

async function captureKiroNativeLogin(fs, runtimeDir, options = {}) {
  try {
    const verification = await prepareKiroIdentityProjection(fs, runtimeDir, options);
    return captureProviderAuth(fs, runtimeDir, 'kiro', { ...options, ...verification });
  } catch (error) {
    return { captured: false, reason: error?.code || 'kiro_identity_unverifiable' };
  }
}

module.exports = { prepareKiroIdentityProjection, registerKiroNativeLogin, captureKiroNativeLogin };
