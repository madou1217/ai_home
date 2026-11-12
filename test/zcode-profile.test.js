'use strict';

// zcode 身份补全回归（2026-11-04 真机）：
//   BigModel 两个账号的 user_info 里 email 为空/打码，但客户信息接口
//   /api/biz/customer/getCustomerInfo 能返回完整 phoneNumber（以及可能更完整的 email）。
//   补全必须：合并到 rawProfile、CAS 写回、保留加密形态、失败节流，且不改动 zai 账号。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyZcodeCustomerInfoToCredentials,
  mergeZcodeCustomerInfo,
  refreshZcodeAccountIdentity,
  shouldRefreshZcodeProfile
} = require('../lib/account/zcode-profile');
const {
  decryptZcodeCredentialValue,
  encryptZcodeCredentialValue
} = require('../lib/account/zcode-credential');
const { readFastAccountPresence } = require('../lib/server/account-presence-probes');
const { buildAccountDisplayNames } = require('../lib/server/account-display-identity');

const BIGMODEL_USER = Object.freeze({
  id: '13999562',
  username: 'yfadmgkl',
  displayName: 'yfadmgkl',
  rawProfile: {
    user_id: '13999562',
    email: '',
    name: 'yfadmgkl',
    zcodeProfileSchemaVersion: 2
  }
});

const BIGMODEL_CUSTOMER = Object.freeze({
  id: 13999562,
  customerNumber: '13999562',
  customerName: 'yfadmgkl',
  nickName: null,
  email: null,
  phoneNumber: '13150311636',
  avatar: ''
});

function zcodeRecord(userInfo, region = 'bigmodel', extraCredentials = {}) {
  return {
    accountRef: 'acct_profile_test',
    provider: 'zcode',
    nativeAuthUpdatedAt: Date.now(),
    nativeAuth: {
      credentials: {
        'oauth:active_provider': region,
        [`oauth:${region}:access_token`]: 'test-access-token',
        [`oauth:${region}:user_info`]: JSON.stringify(userInfo),
        ...extraCredentials
      }
    }
  };
}

function customerResponse(customer = BIGMODEL_CUSTOMER) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, success: true, data: customer })
  };
}

test('mergeZcodeCustomerInfo：补手机号、保留已有昵称、写拉取时间', () => {
  const merged = mergeZcodeCustomerInfo(BIGMODEL_USER, BIGMODEL_CUSTOMER, 1700000000000);
  assert.equal(merged.rawProfile.phoneNumber, '13150311636');
  assert.equal(merged.rawProfile.name, 'yfadmgkl');
  assert.equal(merged.rawProfile.email, '');
  assert.equal(merged.rawProfile.zcodeProfileFetchedAt, 1700000000000);
  assert.equal(merged.displayName, 'yfadmgkl');
});

test('完整邮箱替换打码邮箱；打码邮箱不覆盖已有完整邮箱', () => {
  const masked = { ...BIGMODEL_USER, rawProfile: { ...BIGMODEL_USER.rawProfile, email: 'ma****17@126.com' } };
  const full = mergeZcodeCustomerInfo(masked, {
    ...BIGMODEL_CUSTOMER,
    email: 'madou1217@126.com'
  }, 1);
  assert.equal(full.rawProfile.email, 'madou1217@126.com');

  const fromMaskedApi = mergeZcodeCustomerInfo(full, {
    ...BIGMODEL_CUSTOMER,
    email: 'ma****17@126.com'
  }, 2);
  assert.equal(fromMaskedApi.rawProfile.email, 'madou1217@126.com');
});

test('BigModel 接口返回打码手机号时保留 ****，不剥成 7 位', () => {
  const merged = mergeZcodeCustomerInfo({}, {
    customerNumber: '13999562',
    customerName: 'yfadmgkl',
    phoneNumber: '131****1636'
  }, 1);
  assert.equal(merged.rawProfile.phoneNumber, '131****1636');
});

test('shouldRefreshZcodeProfile：6 小时内不重复拉取', () => {
  const merged = mergeZcodeCustomerInfo(BIGMODEL_USER, BIGMODEL_CUSTOMER, 1700000000000);
  assert.equal(shouldRefreshZcodeProfile(merged, 1700000000000 + 1000, 6 * 3600 * 1000), false);
  assert.equal(shouldRefreshZcodeProfile(merged, 1700000000000 + 7 * 3600 * 1000, 6 * 3600 * 1000), true);
  assert.equal(shouldRefreshZcodeProfile({}, 1700000000000, 6 * 3600 * 1000), true);
});

test('refreshZcodeAccountIdentity：拉取后 CAS 写回，账号记录立刻有 phone', async () => {
  let calls = 0;
  let written = null;
  const record = zcodeRecord(BIGMODEL_USER);
  const result = await refreshZcodeAccountIdentity({
    record,
    accountRef: record.accountRef,
    request: async () => { calls += 1; return customerResponse(); },
    cas: (_fs, _home, _ref, _old, next) => { written = next; return true; },
    nowMs: 1700000000000
  });
  assert.equal(calls, 1);
  assert.equal(result.updated, true);
  assert.equal(result.reason, 'profile_merged');
  const stored = JSON.parse(written.credentials['oauth:bigmodel:user_info']);
  assert.equal(stored.rawProfile.phoneNumber, '13150311636');
  assert.equal(stored.rawProfile.zcodeProfileFetchedAt, 1700000000000);

  const presence = readFastAccountPresence('zcode', { nativeAuth: written, env: {} });
  assert.equal(presence.displayName, 'yfadmgkl');
  assert.equal(presence.nickname, 'yfadmgkl');
  assert.equal(presence.phone, '13150311636');
  assert.equal(presence.email, undefined);
  assert.deepEqual(buildAccountDisplayNames({
    displayName: presence.displayName,
    phone: presence.phone,
    email: presence.email,
    apiKeyMode: presence.apiKeyMode
  }), [
    { type: 'phone', value: '13150311636' },
    { type: 'nickName', value: 'yfadmgkl' }
  ]);
});

test('ttlMs:0 强制刷新，不被 6 小时缓存吞掉', async () => {
  const userInfo = {
    ...BIGMODEL_USER,
    rawProfile: { ...BIGMODEL_USER.rawProfile, zcodeProfileFetchedAt: 999 }
  };
  const record = zcodeRecord(userInfo);
  let calls = 0;
  const result = await refreshZcodeAccountIdentity({
    record,
    accountRef: record.accountRef,
    request: async () => { calls += 1; return customerResponse(); },
    cas: () => true,
    ttlMs: 0,
    nowMs: 1000
  });
  assert.equal(calls, 1);
  assert.equal(result.updated, true);
});

test('refreshZcodeAccountIdentity：加密的 user_info 写回时仍是加密信封', async () => {
  const secret = { env: { ZCODE_CREDENTIAL_SECRET: 'test-secret' } };
  const encrypted = encryptZcodeCredentialValue(JSON.stringify(BIGMODEL_USER), secret);
  const record = zcodeRecord(BIGMODEL_USER, 'bigmodel', {
    'oauth:bigmodel:user_info': encrypted
  });
  let written = null;
  const result = await refreshZcodeAccountIdentity({
    record,
    accountRef: record.accountRef,
    request: async () => customerResponse(),
    cas: (_fs, _home, _ref, _old, next) => { written = next; return true; },
    nowMs: 1700000000000,
    ...secret
  });
  assert.equal(result.updated, true);
  const value = written.credentials['oauth:bigmodel:user_info'];
  assert.match(value, /^enc:v1:/);
  const plain = JSON.parse(decryptZcodeCredentialValue(value, secret));
  assert.equal(plain.rawProfile.phoneNumber, '13150311636');
});

test('refreshZcodeAccountIdentity：zai 账号不走 bigmodel 客户信息接口', async () => {
  let calls = 0;
  const record = zcodeRecord({ user_id: 'u-zai', email: 'a@b.com', name: 'Deo' }, 'zai');
  const result = await refreshZcodeAccountIdentity({
    record,
    accountRef: record.accountRef,
    request: async () => { calls += 1; return customerResponse(); }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_bigmodel');
  assert.equal(calls, 0);
});

test('refreshZcodeAccountIdentity：失败后 10 分钟内不重复打接口', async () => {
  let calls = 0;
  const accountRef = 'acct_profile_failure_' + Date.now();
  const record = { ...zcodeRecord(BIGMODEL_USER), accountRef };
  const first = await refreshZcodeAccountIdentity({
    record,
    accountRef,
    request: async () => { calls += 1; return { ok: false, status: 500, json: async () => null }; },
    cas: () => true,
    nowMs: 1700000000000,
    failureTtlMs: 10 * 60 * 1000
  });
  const second = await refreshZcodeAccountIdentity({
    record,
    accountRef,
    request: async () => { calls += 1; return customerResponse(); },
    cas: () => true,
    nowMs: 1700000000000 + 1000,
    failureTtlMs: 10 * 60 * 1000
  });
  assert.equal(first.failed, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'recent_failure');
  assert.equal(calls, 1);
});

test('applyZcodeCustomerInfoToCredentials：明文凭据写回明文', () => {
  const credentials = applyZcodeCustomerInfoToCredentials(
    { 'oauth:bigmodel:user_info': JSON.stringify(BIGMODEL_USER) },
    'bigmodel',
    { ...BIGMODEL_USER, rawProfile: { ...BIGMODEL_USER.rawProfile, phoneNumber: '13150311636' } }
  );
  assert.equal(JSON.parse(credentials['oauth:bigmodel:user_info']).rawProfile.phoneNumber, '13150311636');
});
