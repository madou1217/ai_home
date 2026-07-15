const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncCodexAccountsToServer } = require('../lib/cli/services/server/sync-codex');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-sync-test-'));
}

test('syncCodexAccountsToServer dry-run counts eligible/invalid', async (t) => {
  const aiHomeDir = mkTmpDir();
  t.after(() => { fs.rmSync(aiHomeDir, { recursive: true, force: true }); });
  const validAccount = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:sync-valid@example.com'
  });
  const invalidAccount = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '2',
    identitySeed: 'oauth:codex:sync-invalid@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, validAccount.accountRef, { auth: {
    tokens: {
      id_token: 'a.b.c',
      access_token: 'at',
      refresh_token: 'opaque-valid',
      account_id: 'aid'
    }
  } });
  writeAccountNativeAuth(fs, aiHomeDir, invalidAccount.accountRef, { auth: {
    tokens: {
      refresh_token: ''
    }
  } });

  const result = await syncCodexAccountsToServer({
    managementUrl: 'http://127.0.0.1:9999/v0/management',
    key: 'dummy',
    parallel: 4,
    limit: 0,
    dryRun: true,
    namePrefix: 'aih-codex-'
  }, {
    fs,
    aiHomeDir,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' })
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.eligible, 1);
  assert.equal(result.skippedInvalid, 1);
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.dryRun, true);
});

test('syncCodexAccountsToServer addresses remote auth files by accountRef', async (t) => {
  const aiHomeDir = mkTmpDir();
  t.after(() => { fs.rmSync(aiHomeDir, { recursive: true, force: true }); });
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '7',
    identitySeed: 'oauth:codex:sync-upload@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { auth: {
    tokens: { refresh_token: 'refresh-token' }
  } });
  const urls = [];

  const result = await syncCodexAccountsToServer({
    managementUrl: 'http://127.0.0.1:9999/v0/management',
    key: 'dummy',
    parallel: 1,
    namePrefix: 'aih-codex-'
  }, {
    fs,
    aiHomeDir,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => '' };
    }
  });

  assert.equal(result.uploaded, 1);
  assert.equal(urls.length, 1);
  assert.match(urls[0], new RegExp(`${registration.accountRef}\\.json$`));
  assert.equal(urls[0].includes('aih-codex-7.json'), false);
});
