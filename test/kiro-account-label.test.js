'use strict';

// kiro 展示名回归（2026-11-04 真机）：
//   * 凭据里的 userInfo 常年为空，旧实现回落 `Kiro (Google)` / `Kiro (AWS Builder ID)`；
//     这只说明登录方式，既不是昵称也不能区分账号。
//   * 正确口径：有邮箱就用邮箱；没有就让展示层等 GetUsageLimits 的 userInfo.email，
//     并且绝不把 `Kiro (Google)` 当作身份项下发。

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeKiroAccount, resolveKiroLoginType } = require('../lib/account/kiro-account-label');
const { createKiroIdentityEvidence } = require('../lib/account/kiro-identity');
const { buildAccountDisplayNames, cleanOauthDisplayName } = require('../lib/server/account-display-identity');
const { createKiroQuotaProbe } = require('../lib/cli/services/usage/kiro-quota-probe');

const AUTH = Object.freeze({
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  region: 'us-east-1',
  provider: 'google'
});

function kiroNativeAuth({ email = '', subject = 'user-1' } = {}) {
  return {
    auth: { ...AUTH },
    identityEvidence: createKiroIdentityEvidence(AUTH, { userInfo: { userId: subject } }, 1000),
    userInfo: email ? { email } : {}
  };
}

test('kiro 没有邮箱时不回落 Kiro (Google)，身份键仍保留', () => {
  const account = describeKiroAccount(kiroNativeAuth());
  assert.equal(account.accountName, '');
  assert.ok(account.identityKey.startsWith('kiro:'));
});

test('kiro 有邮箱时展示名就是邮箱', () => {
  const account = describeKiroAccount(kiroNativeAuth({ email: 'user@example.com' }));
  assert.equal(account.accountName, 'user@example.com');
});

test('resolveKiroLoginType：google / github / builder / idc / desktop', () => {
  assert.equal(resolveKiroLoginType({ auth: { ...AUTH, provider: 'google' } }), 'google');
  assert.equal(resolveKiroLoginType({ auth: { ...AUTH, provider: 'github' } }), 'github');
  assert.equal(resolveKiroLoginType({ auth: { ...AUTH, provider: '', authMethod: 'desktop' } }), 'desktop');

  const oidc = { access_token: 'a', refresh_token: 'r', region: 'us-east-1' };
  assert.equal(resolveKiroLoginType({
    auth: { ...oidc, start_url: 'https://example.awsapps.com/start' },
    registration: { clientId: 'client' }
  }), 'idc');
  assert.equal(resolveKiroLoginType({
    auth: { ...oidc },
    registration: { clientId: 'client' }
  }), 'builder');
});

test('Kiro (Google) / Kiro (AWS Builder ID) 不会被当成展示身份', () => {
  assert.equal(cleanOauthDisplayName('Kiro (Google)'), '');
  assert.equal(cleanOauthDisplayName('Kiro (AWS Builder ID)'), '');

  assert.deepEqual(buildAccountDisplayNames({
    displayName: 'Kiro (Google)',
    nickname: 'Kiro (Google)',
    email: 'user@example.com'
  }), [{ type: 'email', value: 'user@example.com' }]);

  assert.deepEqual(buildAccountDisplayNames({
    displayName: 'Kiro (Google)',
    email: ''
  }), []);
});

function makeKiroRecord(document) {
  const evidence = createKiroIdentityEvidence(AUTH, document, 1000);
  return {
    accountRef: 'acct_kiro_label_test',
    provider: 'kiro',
    nativeAuthUpdatedAt: 1000,
    nativeAuth: {
      auth: { ...AUTH },
      identityEvidence: evidence,
      userInfo: {}
    }
  };
}

test('kiro 用量探测成功后把 GetUsageLimits 的邮箱补进 userInfo（CAS）', async () => {
  const document = {
    userInfo: { userId: 'user-1', email: 'user@example.com' },
    usageBreakdownList: [{
      resourceType: 'CREDIT',
      currentUsageWithPrecision: 10,
      usageLimitWithPrecision: 100
    }],
    subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_PRO', subscriptionTitle: 'Pro' },
    nextDateReset: 1700003600
  };
  const record = makeKiroRecord(document);
  let written = null;
  let writtenRef = '';
  const probe = createKiroQuotaProbe({
    fs: {},
    aiHomeDir: '/tmp/kiro-label-test',
    readAccountCredentialRecord: () => record,
    ensureFreshKiroGrant: async () => ({ record, refreshed: false }),
    fetchKiroUsageLimits: async () => document,
    persistKiroIdentityEvidence: () => ({ persisted: false }),
    compareAndSwapAccountNativeAuth: (_fs, _home, accountRef, _old, next) => {
      writtenRef = accountRef;
      written = next;
      return true;
    },
    now: () => 1000,
    fetchWithTimeout: async () => { throw new Error('unexpected network'); },
    resolveAccountEgressRequestOptions: async () => ({ ok: true, options: {} })
  });
  const result = await probe.probe('acct_kiro_label_test', 5000);
  assert.ok(result.snapshot, JSON.stringify(result));
  assert.equal(writtenRef, 'acct_kiro_label_test');
  assert.equal(written.userInfo.email, 'user@example.com');
  assert.equal(written.identityEvidence.subject, record.nativeAuth.identityEvidence.subject);
});
