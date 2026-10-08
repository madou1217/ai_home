'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKiroQuotaProbe, parseKiroUsagePayload } = require('../lib/cli/services/usage/kiro-quota-probe');
const { createKiroIdentityEvidence } = require('../lib/account/kiro-identity');
const { getMinRemainingPctFromUsageSnapshot, USAGE_SOURCE_KIRO } = require('../lib/account/usage-remaining');
const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');
const { evaluateProviderModelUsage } = require('../lib/server/provider-usage-policy');

const REF = 'acct_0123456789abcdef0123';
const AUTH = { access_token: 'test-access', refresh_token: 'test-refresh', region: 'us-east-1' };
const DOCUMENT = {
  userInfo: { userId: 'kiro-user', email: 'kiro@example.invalid' },
  subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_FREE', subscriptionTitle: 'KIRO FREE' },
  nextDateReset: 1793491200,
  usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsage: 0,
    usageLimitWithPrecision: 50, currentUsageWithPrecision: 0.13 }]
};

test('Kiro credits use decimal precision, official subscription, identity and reset without inventing tokens', () => {
  const snapshot = parseKiroUsagePayload(DOCUMENT, 1000);
  assert.equal(snapshot.source, USAGE_SOURCE_KIRO);
  assert.deepEqual(snapshot.account, { planType: 'free', planName: 'KIRO FREE', email: 'kiro@example.invalid' });
  assert.equal(snapshot.entries[0].remainingUnits, 49.87);
  assert.equal(snapshot.entries[0].remainingPct, 99.74);
  assert.equal(snapshot.entries[0].resetAtMs, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), 99.74);
  const view = normalizeAccountUsageSnapshot(snapshot);
  assert.deepEqual(view.entries, snapshot.entries);
  assert.deepEqual(view.account, snapshot.account);
  assert.equal(evaluateProviderModelUsage('kiro', { accountRef: REF, usageSnapshot: snapshot }, 'auto').remainingPct, 99.74);
});

test('Kiro missing or invalid usage is unknown while a measured zero is valid', () => {
  for (const value of [undefined, null, false, '', -1, '0.13']) {
    assert.equal(parseKiroUsagePayload({ ...DOCUMENT, usageBreakdownList: [{ resourceType: 'CREDIT',
      usageLimit: 50, currentUsageWithPrecision: value }] }, 1000), null);
  }
  const empty = parseKiroUsagePayload({ ...DOCUMENT, usageBreakdownList: [{ resourceType: 'CREDIT',
    usageLimit: 50, currentUsage: 0 }] }, 1000);
  assert.equal(empty.entries[0].remainingPct, 100);
  const exhausted = parseKiroUsagePayload({ ...DOCUMENT, usageBreakdownList: [{ resourceType: 'CREDIT',
    usageLimitWithPrecision: 50, currentUsageWithPrecision: 60 }] }, 1000);
  assert.equal(exhausted.entries[0].remainingPct, 0);
  assert.equal(parseKiroUsagePayload({ ...DOCUMENT, usageBreakdownList: [] }, 1000), null);
});

function fixture(overrides = {}) {
  let record = { provider: 'kiro', accountRef: REF,
    nativeAuth: { auth: AUTH, identityEvidence: createKiroIdentityEvidence(AUTH, DOCUMENT, 1000) } };
  const requests = [], captures = [];
  const service = createKiroQuotaProbe({
    fs: {}, aiHomeDir: '/tmp/aih-kiro-unit', usageSnapshotSchemaVersion: 2, now: () => 2000,
    readAccountCredentialRecord: () => record,
    readKiroTokenFromDatabase: () => AUTH,
    resolveAccountEgressRequestOptions: async input => {
      assert.equal(input.provider, 'kiro');
      assert.equal(input.accountRef, REF);
      return { ok: true, options: { proxyUrl: 'http://account-proxy' } };
    },
    fetchWithTimeout: async (...args) => {
      requests.push(args);
      return new Response(JSON.stringify(DOCUMENT));
    },
    captureKiroNativeLogin: async (...args) => { captures.push(args); return { captured: true }; },
    ...overrides
  });
  return { service, requests, captures, setRecord: value => { record = value; }, getRecord: () => record };
}

test('Kiro quota follows account egress and the same authenticated AWS identity contract', async () => {
  const f = fixture();
  const result = await f.service.probe(REF, 5000);
  assert.equal(result.snapshot.schemaVersion, 2);
  assert.equal(result.snapshot.entries[0].remainingPct, 99.74);
  assert.equal(f.captures.length, 0);
  assert.equal(f.requests.length, 1);
  const [url, init, timeout, egress] = f.requests[0];
  assert.equal(new URL(url).hostname, 'codewhisperer.us-east-1.amazonaws.com');
  assert.equal(init.headers['x-amz-target'], 'AmazonCodeWhispererService.GetUsageLimits');
  assert.equal(init.headers.authorization, 'Bearer test-access');
  assert.equal(JSON.parse(init.body).isEmailRequired, true);
  assert.equal(timeout, 5000);
  assert.deepEqual(egress, { proxyUrl: 'http://account-proxy' });
});

test('a renewed native Kiro token is adopted only through identity-verified capture', async () => {
  const fresh = { ...AUTH, access_token: 'renewed-access' };
  let f;
  f = fixture({ readKiroTokenFromDatabase: () => fresh,
    captureKiroNativeLogin: async (_fs, dir, options) => {
      assert.equal(dir, '/tmp/aih-kiro-unit/run/auth-projections/kiro/' + REF);
      assert.equal(options.accountRef, REF);
      assert.equal(typeof options.request, 'function');
      f.setRecord({ ...f.getRecord(), nativeAuth: { auth: fresh,
        identityEvidence: createKiroIdentityEvidence(fresh, DOCUMENT, 1500) } });
      return { captured: true };
    }
  });
  assert.equal((await f.service.probe(REF)).snapshot.entries[0].remainingPct, 99.74);
  assert.equal(f.requests[0][1].headers.authorization, 'Bearer renewed-access');
  const rejected = fixture({ readKiroTokenFromDatabase: () => fresh,
    captureKiroNativeLogin: async () => ({ captured: false, reason: 'account_identity_mismatch' }) });
  assert.equal((await rejected.service.probe(REF)).error, 'account_identity_mismatch');
  assert.equal(rejected.requests.length, 0);
});

test('foreign users and credentials changed while probing cannot populate Kiro quota', async () => {
  const foreign = fixture({ fetchWithTimeout: async () => new Response(JSON.stringify({
    ...DOCUMENT, userInfo: { ...DOCUMENT.userInfo, userId: 'foreign-user' }
  })) });
  assert.equal((await foreign.service.probe(REF)).error, 'account_identity_mismatch');
  let changed;
  changed = fixture({ fetchWithTimeout: async () => {
    changed.setRecord({ ...changed.getRecord(), nativeAuth: { auth: { ...AUTH, access_token: 'external-update' } } });
    return new Response(JSON.stringify(DOCUMENT));
  } });
  assert.equal((await changed.service.probe(REF)).error, 'credential_changed_during_probe');
  const denied = fixture({ fetchWithTimeout: async () => new Response('', { status: 403 }) });
  assert.equal((await denied.service.probe(REF)).error, 'kiro_identity_access_denied');
});
