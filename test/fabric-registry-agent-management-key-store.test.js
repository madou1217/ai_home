const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRegistryAgentManagementKey,
  deleteRegistryAgentManagementKey,
  readRegistryAgentManagementKey,
  writeRegistryAgentManagementKey
} = require('../lib/cli/services/fabric/registry-agent-management-key-store');

test('registry agent Management Key store persists Management Keys only in app-state.db', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-management-key-store-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  assert.equal(buildRegistryAgentManagementKey('Office Node'), 'fabric:registry-agent-management-key:office-node');
  assert.equal(writeRegistryAgentManagementKey('Office Node', 'management-secret', { fs, aiHomeDir }), true);
  assert.equal(readRegistryAgentManagementKey('office-node', { fs, aiHomeDir }), 'management-secret');
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'app-state.db')), true);
  assert.deepEqual(
    fs.readdirSync(aiHomeDir).filter((name) => !name.startsWith('app-state.db')),
    ['run']
  );
  // The only additional store is a secret-free OS-lock coordination database.
  // Inspect its schema and content instead of allowing arbitrary sidecar files.
  const maintenance = path.join(aiHomeDir, 'run', 'maintenance');
  assert.deepEqual(fs.readdirSync(path.join(aiHomeDir, 'run')), ['maintenance']);
  assert.deepEqual(fs.readdirSync(maintenance), ['access.sqlite']);
  const { DatabaseSync } = require('node:sqlite');
  const lock = new DatabaseSync(path.join(maintenance, 'access.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(lock.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['lease']);
    assert.deepEqual(lock.prepare('SELECT id FROM lease').all().map(row => row.id), [1]);
  } finally { lock.close(); }
  assert.equal(fs.readFileSync(path.join(maintenance, 'access.sqlite')).includes(Buffer.from('management-secret')), false);

  assert.equal(deleteRegistryAgentManagementKey('office-node', { fs, aiHomeDir }), true);
  assert.equal(readRegistryAgentManagementKey('office-node', { fs, aiHomeDir }), '');
});

test('registry agent Management Key store rejects invalid node ids and empty Management Keys', () => {
  assert.throws(
    () => writeRegistryAgentManagementKey('', 'management-secret', { fs, aiHomeDir: '/tmp/unused' }),
    { code: 'invalid_fabric_node_id' }
  );
  assert.throws(
    () => writeRegistryAgentManagementKey('office-node', '', { fs, aiHomeDir: '/tmp/unused' }),
    { code: 'missing_management_key' }
  );
});
