'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveAccountRuntimeDir,
  resolveAihLogPath,
  resolveAihRunPath,
  resolveCodexDesktopRuntimeDir
} = require('../lib/runtime/aih-storage-layout');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { writeTransferMetadata } = require('../lib/account/transfer-metadata-store');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { saveAliases } = require('../lib/server/model-alias-store');
const { appendBoundedJsonLine } = require('../lib/server/bounded-log-writer');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { createProfileLayoutService } = require('../lib/cli/services/profile/layout');

test('AIH storage layout uses accountRef and has no gateway profile path', () => {
  const aiHomeDir = path.join('/tmp', '.ai_home');
  const accountRef = 'acct_0123456789abcdef0123';

  assert.equal(
    resolveAccountRuntimeDir(aiHomeDir, 'gemini', accountRef),
    path.join(aiHomeDir, 'run', 'auth-projections', 'gemini', accountRef)
  );
  assert.equal(
    resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef),
    path.join(aiHomeDir, 'run', 'codex-desktop', accountRef)
  );
  assert.equal(resolveAccountRuntimeDir(aiHomeDir, 'gemini', '1'), '');
});

test('profile layout resolves gateway and all Claude state directly to the shared host home', () => {
  const aiHomeDir = path.join('/tmp', '.ai_home');
  const hostHomeDir = path.join('/tmp', 'host');
  const layout = createProfileLayoutService({ fs, aiHomeDir, hostHomeDir });

  assert.equal(layout.getGatewayRuntimeDir('claude'), hostHomeDir);
  assert.equal(layout.getProfileDir('claude', '', { gateway: true }), hostHomeDir);
  assert.equal(layout.getProfileDir('claude', 'acct_0123456789abcdef0123'), hostHomeDir);
  assert.equal(
    layout.getAccountRuntimeDir('claude', 'acct_0123456789abcdef0123'),
    path.join(aiHomeDir, 'run', 'auth-projections', 'claude', 'acct_0123456789abcdef0123')
  );
});

test('AIH storage layout rejects traversal and compound path segments', () => {
  const aiHomeDir = path.join('/tmp', '.ai_home');

  assert.equal(resolveAihRunPath(aiHomeDir, '..', 'escape'), '');
  assert.equal(resolveAihLogPath(aiHomeDir, 'codex/../../escape.log'), '');
  assert.equal(resolveAihLogPath(aiHomeDir, 'codex', 'app-server.log'), path.join(
    aiHomeDir,
    'logs',
    'codex',
    'app-server.log'
  ));
});

test('AIH storage layout keeps Windows roots canonical on non-Windows hosts', () => {
  const aiHomeDir = 'C:\\Users\\alice\\.ai_home';

  assert.equal(
    resolveAihRunPath(aiHomeDir, 'server.pid'),
    'C:\\Users\\alice\\.ai_home\\run\\server.pid'
  );
  assert.equal(
    resolveAihLogPath(aiHomeDir, 'server.log'),
    'C:\\Users\\alice\\.ai_home\\logs\\server.log'
  );
});

test('core stores keep AIH root to one database plus run and logs', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-storage-contract-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'gemini',
    identitySeed: 'oauth:gemini:storage-contract@example.com'
  });

  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    oauthCreds: { refresh_token: 'refresh-token' },
    googleAccounts: { active: 'storage-contract@example.com' }
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'gemini', registration.accountRef);
  writeAccountUsageSnapshot(fs, aiHomeDir, registration.accountRef, { remainingPct: 80 });
  writeTransferMetadata(fs, aiHomeDir, registration.accountRef, { formats: { sub2api: { notes: 'test' } } });
  await saveAliases(fs, aiHomeDir, {
    aliases: [{ id: 'alias-1', alias: 'fast', target: 'gemini-2.5-flash' }]
  });

  const usageStore = openModelUsageStore({ fs, aiHomeDir });
  assert.ok(usageStore);
  usageStore.close();

  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'gemini', registration.accountRef);
  fs.mkdirSync(runtimeDir, { recursive: true });
  appendBoundedJsonLine(fs, resolveAihLogPath(aiHomeDir, 'contract.jsonl'), { ok: true }, { path });

  const rootEntries = fs.readdirSync(aiHomeDir).sort();
  assert.deepEqual(
    rootEntries.filter((name) => !/^app-state\.db(?:-(?:shm|wal))?$/.test(name)),
    ['logs', 'run']
  );
  assert.equal(rootEntries.some((name) => name === 'profiles'), false);
  assert.equal(rootEntries.filter((name) => name.endsWith('.db')).length, 1);
});
