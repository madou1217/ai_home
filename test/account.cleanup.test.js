const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountCleanupService } = require('../lib/cli/services/account/cleanup');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  resolveAccountRef,
  resolveAccountRefByCliId
} = require('../lib/server/account-ref-store');
const {
  resolveAccountRuntimeDir,
  resolveCodexDesktopRuntimeDir
} = require('../lib/runtime/aih-storage-layout');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-cleanup-'));
}

function createService(aiHomeDir, deletedStates = []) {
  return createAccountCleanupService({
    fs,
    path,
    aiHomeDir,
    accountStateService: {
      deleteAccount: (accountRef) => {
        deletedStates.push(accountRef);
        return true;
      }
    }
  });
}

function registerAccount(aiHomeDir, provider, cliAccountId) {
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:${cliAccountId}@example.com`
  }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { auth: { token: cliAccountId } });
  return accountRef;
}

test('parseDeleteSelectorTokens supports ids comma lists and ranges', () => {
  const service = createService('/tmp/aih-cleanup-test');
  assert.deepEqual(service.parseDeleteSelectorTokens(['3,1', '2-4', '4']), ['1', '2', '3', '4']);
  assert.throws(() => service.parseDeleteSelectorTokens(['4-2']), /invalid_delete_selector:4-2/);
  assert.throws(() => service.parseDeleteSelectorTokens(['abc']), /invalid_delete_selector:abc/);
});

test('deleteAccountsForCli removes requested accounts and reports missing ids', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account1Ref = registerAccount(root, 'codex', '1');
  const account3Ref = registerAccount(root, 'codex', '3');
  const account1RuntimeDir = resolveAccountRuntimeDir(root, 'codex', account1Ref);
  const account1DesktopRuntimeDir = resolveCodexDesktopRuntimeDir(root, account1Ref);
  fs.mkdirSync(account1RuntimeDir, { recursive: true });
  fs.mkdirSync(account1DesktopRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(account1RuntimeDir, 'auth.json'), 'runtime');
  fs.writeFileSync(path.join(account1DesktopRuntimeDir, 'auth.json'), 'desktop');
  const deletedStates = [];
  const service = createService(root, deletedStates);

  const result = service.deleteAccountsForCli('codex', ['1', '2', '3']);

  assert.deepEqual(result.deletedIds, ['1', '3']);
  assert.deepEqual(result.missingIds, ['2']);
  assert.equal(readAccountCredentialRecord(fs, root, account1Ref), null);
  assert.equal(readAccountCredentialRecord(fs, root, account3Ref), null);
  assert.equal(fs.existsSync(account1RuntimeDir), false);
  assert.equal(fs.existsSync(account1DesktopRuntimeDir), false);
  assert.deepEqual(deletedStates, [account1Ref, account3Ref]);
});

test('deleteAllAccountsForCli deletes DB-registered provider accounts', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  registerAccount(root, 'gemini', '1');
  registerAccount(root, 'gemini', '2');
  const service = createService(root);

  const result = service.deleteAllAccountsForCli('gemini');

  assert.deepEqual(result.deletedIds, ['1', '2']);
  assert.equal(result.totalBeforeDelete, 2);
  assert.equal(resolveAccountRefByCliId(fs, root, 'gemini', '1'), null);
  assert.equal(resolveAccountRefByCliId(fs, root, 'gemini', '2'), null);
});

test('deleteAccountByRef does not depend on the CLI alias', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerAccount(root, 'opencode', '4');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'app-state.db'));
  try {
    db.prepare('DELETE FROM account_cli_aliases WHERE account_ref = ?').run(accountRef);
  } finally {
    db.close();
  }

  const result = createService(root).deleteAccountByRef('opencode', accountRef);

  assert.equal(result.deleted, true);
  assert.equal(result.accountRef, accountRef);
  assert.equal(Object.hasOwn(result, 'cliAccountId'), false);
  assert.equal(resolveAccountRef(fs, root, accountRef), null);
  assert.equal(readAccountCredentialRecord(fs, root, accountRef), null);
});
