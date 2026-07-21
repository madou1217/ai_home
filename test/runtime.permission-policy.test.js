const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PERMISSION_POLICY_KEY,
  loadPermissionPolicy,
  savePermissionPolicy,
  shouldUseDangerFullAccess
} = require('../lib/runtime/permission-policy');
const { openAppStateDatabase } = require('../lib/server/app-state-store');

test('permission policy persists and reloads normalized sandbox options', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-policy-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const saved = savePermissionPolicy({
    exec: {
      defaultSandbox: 'danger-full-access',
      allowDangerFullAccess: true
    }
  }, { fs, aiHomeDir: tempDir });

  assert.equal(saved.exec.defaultSandbox, 'danger-full-access');
  assert.equal(saved.exec.allowDangerFullAccess, true);
  assert.equal(typeof saved.updatedAt, 'string');
  assert.equal(saved.updatedAt.length > 0, true);

  const loaded = loadPermissionPolicy({ fs, aiHomeDir: tempDir });
  assert.equal(loaded.exec.defaultSandbox, 'danger-full-access');
  assert.equal(loaded.exec.allowDangerFullAccess, true);
  assert.equal(shouldUseDangerFullAccess(loaded), true);
});

test('invalid policy payload falls back to safe defaults', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-policy-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, tempDir);
  db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(PERMISSION_POLICY_KEY, '{invalid-json', Date.now());
  db.close();

  const loaded = loadPermissionPolicy({ fs, aiHomeDir: tempDir });
  assert.equal(loaded.exec.defaultSandbox, 'workspace-write');
  assert.equal(loaded.exec.allowDangerFullAccess, false);
  assert.equal(shouldUseDangerFullAccess(loaded), false);
});
