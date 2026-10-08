'use strict';

const path = require('node:path');
const { readAccountCredentialRecord } = require('../../../server/account-credential-store');
const { readKiroTokenFromDatabase } = require('../../../account/kiro-auth-metadata');
const { fetchKiroUsageLimits } = require('../../../account/kiro-usage-client');
const { createKiroIdentityEvidence, kiroTokenBinding } = require('../../../account/kiro-identity');
const { captureKiroNativeLogin } = require('../../../account/kiro-native-login');
const { resolveAccountRuntimeDir } = require('../../../runtime/aih-storage-layout');
const { resolveProviderAccountEgressRequestOptions } = require('../../../server/account-egress-request-options');
const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_KIRO } = require('../../../account/usage-remaining');

function amount(precise, fallback) {
  const value = precise ?? fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseKiroUsagePayload(document, capturedAt) {
  const resource = Array.isArray(document?.usageBreakdownList)
    ? document.usageBreakdownList.find(row => row?.resourceType === 'CREDIT') : null;
  if (!resource) return null;
  const usedUnits = amount(resource.currentUsageWithPrecision, resource.currentUsage);
  const totalUnits = amount(resource.usageLimitWithPrecision, resource.usageLimit);
  if (usedUnits == null || !(totalUnits > 0)) return null;
  const remainingUnits = Math.max(0, totalUnits - usedUnits);
  const reset = resource.nextDateReset ?? document.nextDateReset;
  const resetAtMs = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
  const planName = String(document.subscriptionInfo?.subscriptionTitle || '').trim();
  const planType = String(document.subscriptionInfo?.type || '').replace(/^Q_DEVELOPER_STANDALONE_/, '').toLowerCase();
  return { kind: USAGE_SNAPSHOT_KINDS.kiro, capturedAt, source: USAGE_SOURCE_KIRO,
    account: { email: String(document.userInfo?.email || '').trim(), planName, planType },
    entries: [{ bucket: 'credits', totalUnits, usedUnits, remainingUnits, unitType: 'credits',
      remainingPct: remainingUnits / totalUnits * 100,
      windowMinutes: 0, window: '', resetIn: '', resetAtMs }] };
}

function createKiroQuotaProbe(options = {}) {
  const readRecord = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const readToken = options.readKiroTokenFromDatabase || readKiroTokenFromDatabase;
  const capture = options.captureKiroNativeLogin || captureKiroNativeLogin;
  const fetchUsage = options.fetchKiroUsageLimits || fetchKiroUsageLimits;
  const now = options.now || Date.now;

  async function probe(accountRef, probeTimeoutMs) {
    let record = readRecord(options.fs, options.aiHomeDir, accountRef);
    if (record?.provider !== 'kiro' || !record.nativeAuth?.identityEvidence) return { error: 'credential_record_missing' };
    const runtimeDir = resolveAccountRuntimeDir(options.aiHomeDir, 'kiro', accountRef);
    const egress = await resolveProviderAccountEgressRequestOptions({
      account: { provider: 'kiro', accountRef },
      options: { proxyUrl: options.proxyUrl, noProxy: options.noProxy }, deps: options
    });
    if (!egress?.ok || !egress.options) return { error: egress?.error || 'account_egress_unavailable' };
    const request = (url, init) => options.fetchWithTimeout(url, init,
      Math.max(1000, Number(probeTimeoutMs) || 10000), egress.options);
    try {
      const nativeToken = readToken(path.join(runtimeDir, 'data.sqlite3'));
      if (nativeToken && kiroTokenBinding(nativeToken) !== kiroTokenBinding(record.nativeAuth.auth)) {
        // An active CLI owns renewal. Verify its user before CAS adoption;
        // never copy a foreign grant into the selected account.
        const result = await capture(options.fs, runtimeDir, { aiHomeDir: options.aiHomeDir, accountRef, request });
        if (!result.captured && result.reason !== 'unchanged') return { error: result.reason || 'credential_sync_failed' };
        record = readRecord(options.fs, options.aiHomeDir, accountRef);
      }
      const document = await fetchUsage(record.nativeAuth, { request });
      const evidence = createKiroIdentityEvidence(record.nativeAuth.auth, document, now());
      if (!evidence || evidence.subject !== record.nativeAuth.identityEvidence.subject
        || evidence.endpoint !== record.nativeAuth.identityEvidence.endpoint) return { error: 'account_identity_mismatch' };
      const latest = readRecord(options.fs, options.aiHomeDir, accountRef);
      if (kiroTokenBinding(latest?.nativeAuth?.auth) !== evidence.tokenBinding) return { error: 'credential_changed_during_probe' };
      const snapshot = parseKiroUsagePayload(document, now());
      if (!snapshot) return { error: 'kiro_credit_usage_missing' };
      snapshot.schemaVersion = options.usageSnapshotSchemaVersion;
      return { snapshot };
    } catch (error) {
      return { error: error.code || 'kiro_usage_probe_failed',
        auth: ['kiro_identity_authentication_failed', 'kiro_identity_access_denied'].includes(error.code) };
    }
  }
  return { probe };
}

module.exports = { createKiroQuotaProbe, parseKiroUsagePayload };
