const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountCleanupService } = require('../lib/cli/services/account/cleanup');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-cleanup-'));
}

function createService(profilesDir, deletedStates = []) {
  return createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    accountStateService: {
      deleteAccount: (provider, id) => {
        deletedStates.push({ provider, id });
        return true;
      }
    }
  });
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
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex', '3'), { recursive: true });
  const deletedStates = [];
  const service = createService(profilesDir, deletedStates);

  const result = service.deleteAccountsForCli('codex', ['1', '2', '3']);

  assert.deepEqual(result.deletedIds, ['1', '3']);
  assert.deepEqual(result.missingIds, ['2']);
  assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '1')), false);
  assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '3')), false);
  assert.deepEqual(deletedStates, [
    { provider: 'codex', id: '1' },
    { provider: 'codex', id: '3' }
  ]);
});

test('deleteAllAccountsForCli deletes numeric account directories only', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'gemini', '1'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'gemini', '2'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'gemini', '.aih_default'), { recursive: true });
  const service = createService(profilesDir);

  const result = service.deleteAllAccountsForCli('gemini');

  assert.deepEqual(result.deletedIds, ['1', '2']);
  assert.equal(result.totalBeforeDelete, 2);
  assert.equal(fs.existsSync(path.join(profilesDir, 'gemini', '1')), false);
  assert.equal(fs.existsSync(path.join(profilesDir, 'gemini', '2')), false);
  assert.equal(fs.existsSync(path.join(profilesDir, 'gemini', '.aih_default')), true);
});
