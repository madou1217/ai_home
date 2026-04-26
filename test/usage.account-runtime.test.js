const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsageAccountRuntimeService } = require('../lib/cli/services/usage/account-runtime');

test('refreshIndexedStateForAccount preserves manually disabled status while updating usage fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-account-runtime-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    const profileDir = path.join(profilesDir, 'codex', '1');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.aih_status'), 'down\n', 'utf8');

    const upserts = [];
    const service = createUsageAccountRuntimeService({
      path,
      fs,
      profilesDir,
      cliConfigs: { codex: {} },
      createUsageScheduler: () => ({ start() {} }),
      getAccountStateIndex: () => ({
        getAccountState() {
          return { status: 'down' };
        }
      }),
      stateIndexClient: {
        upsert(_cliName, _id, payload) {
          upserts.push(payload);
        },
        pruneMissing() {}
      },
      lastActiveAccountByCli: {},
      usageIndexStaleRefreshMs: 60_000,
      usageIndexBgRefreshLimit: 10,
      getProfileDir: (_cliName, id) => path.join(profilesDir, 'codex', String(id)),
      checkStatus: () => ({ configured: true, accountName: 'user@example.com' }),
      readUsageCache: () => ({
        kind: 'codex_oauth_status',
        entries: [{ window: '5h', remainingPct: 33 }]
      }),
      ensureUsageSnapshot: (_cliName, _id, cache) => cache
    });

    const result = service.refreshIndexedStateForAccount('codex', '1', { refreshSnapshot: false });
    assert.equal(result.status, 'down');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].status, 'down');
    assert.equal(upserts[0].remainingPct, 33);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
