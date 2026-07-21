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
    []
  );

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
