const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncCodexAccountsToServer } = require('../lib/server/sync');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-sync-test-'));
}

test('syncCodexAccountsToServer dry-run counts eligible/invalid', async (t) => {
  const root = mkTmpDir();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const c1 = path.join(root, '1');
  const c2 = path.join(root, '2');
  fs.mkdirSync(c1, { recursive: true });
  fs.mkdirSync(c2, { recursive: true });

  fs.writeFileSync(path.join(c1, 'auth.json'), JSON.stringify({
    tokens: {
      id_token: 'a.b.c',
      access_token: 'at',
      refresh_token: 'rt_valid',
      account_id: 'aid'
    }
  }));
  fs.writeFileSync(path.join(c2, 'auth.json'), JSON.stringify({
    tokens: {
      refresh_token: 'invalid'
    }
  }));

  const result = await syncCodexAccountsToServer({
    managementUrl: 'http://127.0.0.1:9999/v0/management',
    key: 'dummy',
    parallel: 4,
    limit: 0,
    dryRun: true,
    namePrefix: 'aih-codex-'
  }, {
    fs,
    getToolAccountIds: () => ['1', '2'],
    getToolConfigDir: (_tool, id) => path.join(root, String(id)),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' })
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.eligible, 1);
  assert.equal(result.skippedInvalid, 1);
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.dryRun, true);
});
