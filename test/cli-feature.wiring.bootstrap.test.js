const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCodexImportWiring,
  createCodexPolicyWiring,
  createCliHelpWiring
} = require('../lib/cli/bootstrap/cli-feature-wiring');

test('createCodexImportWiring maps codex import dependencies', () => {
  let receivedArg = null;
  const parseCodexBulkImportArgs = () => ({});
  const importCodexTokensFromOutput = async () => ({});

  const out = createCodexImportWiring({
    path: {},
    fs: {},
    crypto: {},
    profilesDir: '/tmp/profiles',
    getDefaultParallelism: () => 4,
    getToolAccountIds: () => [],
    ensureDir: () => {},
    getProfileDir: () => '/tmp/p',
    getToolConfigDir: () => '/tmp/t'
  }, {
    createCodexBulkImportService: (arg) => {
      receivedArg = arg;
      return { parseCodexBulkImportArgs, importCodexTokensFromOutput };
    }
  });

  assert.equal(out.parseCodexBulkImportArgs, parseCodexBulkImportArgs);
  assert.equal(out.importCodexTokensFromOutput, importCodexTokensFromOutput);
  assert.equal(receivedArg.profilesDir, '/tmp/profiles');
});

test('createCodexPolicyWiring maps policy dependencies', () => {
  let receivedArg = null;
  const showCodexPolicy = () => {};
  const setCodexPolicy = () => {};

  const out = createCodexPolicyWiring({
    aiHomeDir: '/tmp/aih',
    loadPermissionPolicy: () => ({}),
    savePermissionPolicy: () => {},
    shouldUseDangerFullAccess: () => false
  }, {
    createCodexPolicyService: (arg) => {
      receivedArg = arg;
      return { showCodexPolicy, setCodexPolicy };
    }
  });

  assert.equal(out.showCodexPolicy, showCodexPolicy);
  assert.equal(out.setCodexPolicy, setCodexPolicy);
  assert.equal(receivedArg.aiHomeDir, '/tmp/aih');
});

test('createCliHelpWiring maps help dependencies', () => {
  let receivedArg = null;
  const showHelp = () => {};
  const showCliUsage = () => {};

  const out = createCliHelpWiring({
    log: () => {}
  }, {
    createCliHelpService: (arg) => {
      receivedArg = arg;
      return { showHelp, showCliUsage };
    }
  });

  assert.equal(out.showHelp, showHelp);
  assert.equal(out.showCliUsage, showCliUsage);
  assert.equal(typeof receivedArg.log, 'function');
});
