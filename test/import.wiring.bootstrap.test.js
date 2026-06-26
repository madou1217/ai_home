const test = require('node:test');
const assert = require('node:assert/strict');
const { createImportWiring } = require('../lib/cli/bootstrap/import-wiring');

test('createImportWiring maps standard JSON import dependencies', () => {
  let receivedArg = null;
  const runUnifiedImport = async () => ({});
  const out = createImportWiring({
    fs: {},
    path: {},
    os: {},
    fse: {},
    execSync: () => {},
    spawnImpl: () => {},
    processObj: {},
    cryptoImpl: {},
    aiHomeDir: '/tmp/aih',
    cliConfigs: { codex: {} },
    getToolAccountIds: () => [],
    getProfileDir: () => '/tmp/profile',
    getToolConfigDir: () => '/tmp/config',
    accountArtifactHooks: { hooks: true }
  }, {
    createUnifiedImportService: (arg) => {
      receivedArg = arg;
      return {
        parseUnifiedImportArgs: () => ({}),
        runUnifiedImport
      };
    }
  });

  assert.equal(out.runUnifiedImport, runUnifiedImport);
  assert.equal(receivedArg.aiHomeDir, '/tmp/aih');
  assert.deepEqual(receivedArg.accountArtifactHooks, { hooks: true });
  assert.equal(typeof receivedArg.getToolAccountIds, 'function');
  assert.equal(typeof receivedArg.getProfileDir, 'function');
  assert.equal(typeof receivedArg.getToolConfigDir, 'function');
});
