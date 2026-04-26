const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadPermissionPolicy,
  savePermissionPolicy,
  shouldUseDangerFullAccess
} = require('../lib/runtime/permission-policy');

test('permission policy persists and reloads normalized sandbox options', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-policy-'));
  const policyFile = path.join(tempDir, 'exec-policy.json');

  const saved = savePermissionPolicy({
    exec: {
      defaultSandbox: 'danger-full-access',
      allowDangerFullAccess: true
    }
  }, { policyFile });

  assert.equal(saved.exec.defaultSandbox, 'danger-full-access');
  assert.equal(saved.exec.allowDangerFullAccess, true);
  assert.equal(typeof saved.updatedAt, 'string');
  assert.equal(saved.updatedAt.length > 0, true);

  const loaded = loadPermissionPolicy({ policyFile });
  assert.equal(loaded.exec.defaultSandbox, 'danger-full-access');
  assert.equal(loaded.exec.allowDangerFullAccess, true);
  assert.equal(shouldUseDangerFullAccess(loaded), true);
});

test('invalid policy payload falls back to safe defaults', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-policy-'));
  const policyFile = path.join(tempDir, 'exec-policy.json');
  fs.writeFileSync(policyFile, '{invalid-json', 'utf8');

  const loaded = loadPermissionPolicy({ policyFile });
  assert.equal(loaded.exec.defaultSandbox, 'workspace-write');
  assert.equal(loaded.exec.allowDangerFullAccess, false);
  assert.equal(shouldUseDangerFullAccess(loaded), false);
});
