'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const {
  loadQoderServerAccounts,
  loadServerRuntimeAccounts
} = require('../lib/server/accounts');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-runtime-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'qodercn',
    cliAccountId: '1',
    identitySeed: 'oauth:qodercn:user@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    credentials: 'opaque-official-credential',
    userInfo: { email: 'user@example.com' }
  });
  return {
    accountRef,
    deps: {
      fs,
      aiHomeDir,
      accountStateIndex: new Map(),
      checkStatus: () => ({ configured: true, accountName: 'user@example.com' }),
      getProfileDir: (provider, ref) => path.join(aiHomeDir, provider, ref)
    }
  };
}

test('loadQoderServerAccounts exposes OAuth account as schedulable', (t) => {
  const fixture = createFixture(t);
  const accounts = loadQoderServerAccounts(fixture.deps, 'qodercn');

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountRef, fixture.accountRef);
  assert.equal(accounts[0].displayName, 'user@example.com');
  assert.equal(accounts[0].quotaStatus, 'not_applicable');
  assert.equal(accounts[0].schedulableStatus, 'schedulable');
  assert.equal(accounts[0].accessToken, '');
});

test('loadServerRuntimeAccounts includes both Qoder buckets', (t) => {
  const fixture = createFixture(t);
  const accounts = loadServerRuntimeAccounts(fixture.deps);

  assert.deepEqual(accounts.qoder, []);
  assert.equal(accounts.qodercn.length, 1);
  assert.equal(accounts.qodercn[0].accountRef, fixture.accountRef);
});
