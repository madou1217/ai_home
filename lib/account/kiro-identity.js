'use strict';

const crypto = require('node:crypto');
const { canonicalSubject, digestSubject } = require('./identity-subject');

const EVIDENCE_SOURCE = 'aws-codewhisperer:GetUsageLimits';
const EVIDENCE_VERSION = 1;

/**
 * OIDC registration IDs identify a client, not a person. A Kiro account must be
 * named by UserInfo.userId from an authenticated GetUsageLimits response. The
 * evidence is AIH metadata, not a field claimed to exist in the native token DB.
 * Source: aws/amazon-q-developer-cli @ 15cc8f3, UserInfo/GetUsageLimitsOutput.
 */
function kiroEndpoint(auth) {
  const region = auth?.region === undefined ? 'us-east-1' : auth.region;
  if (typeof region !== 'string' || !/^[a-z]{2}-[a-z]+-\d$/.test(region)) return '';
  return `https://codewhisperer.${region}.amazonaws.com`;
}

function kiroTokenBinding(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return '';
  const access = auth.access_token || auth.accessToken;
  const refresh = auth.refresh_token || auth.refreshToken || '';
  if (typeof access !== 'string' || !access || access !== access.trim() || access.length > 262144
    || typeof refresh !== 'string' || refresh !== refresh.trim() || refresh.length > 262144
    || !kiroEndpoint(auth)) return '';
  // A stale identity response must not be attached to a newly observed grant.
  return crypto.createHash('sha256').update(JSON.stringify([kiroEndpoint(auth), access, refresh])).digest('hex');
}

function createKiroIdentityEvidence(auth, response, observedAtMs = Date.now()) {
  const subject = canonicalSubject(response?.userInfo?.userId);
  const binding = kiroTokenBinding(auth);
  if (!subject || !binding || !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) return null;
  return {
    version: EVIDENCE_VERSION,
    source: EVIDENCE_SOURCE,
    endpoint: kiroEndpoint(auth),
    subject,
    tokenBinding: binding,
    observedAtMs
  };
}

/**
 * Evidence only proves local source consistency, not a cryptographic signature.
 * It is created by the authenticated probe, persisted with the grant, and
 * checked again at import/capture boundaries. Rotation requires new evidence;
 * it never creates an identity from the token's bytes.
 */
function buildKiroIdentitySeed(nativeAuth) {
  const auth = nativeAuth?.auth;
  const evidence = nativeAuth?.identityEvidence;
  if (!evidence || evidence.version !== EVIDENCE_VERSION || evidence.source !== EVIDENCE_SOURCE
    || evidence.endpoint !== kiroEndpoint(auth) || !canonicalSubject(evidence.subject)
    || !Number.isSafeInteger(evidence.observedAtMs) || evidence.observedAtMs <= 0
    || !evidence.tokenBinding || evidence.tokenBinding !== kiroTokenBinding(auth)) return '';
  // The service authority scopes the subject. Equal strings issued by different
  // regional identity authorities must not silently merge local accounts.
  return `oauth:kiro:user:${digestSubject(`${evidence.endpoint}\n${evidence.subject}`)}`;
}

module.exports = {
  EVIDENCE_SOURCE,
  EVIDENCE_VERSION,
  buildKiroIdentitySeed,
  createKiroIdentityEvidence,
  kiroEndpoint,
  kiroTokenBinding
};
