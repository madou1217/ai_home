const test = require('node:test');
const assert = require('node:assert/strict');

const serverArgs = require('../lib/server/args');
const cliServerArgs = require('../lib/cli/services/server/args');

test('cli server args module reuses canonical server args implementation', () => {
  assert.equal(cliServerArgs.parseServerSyncArgs, serverArgs.parseServerSyncArgs);
  assert.equal(cliServerArgs.parseServerServeArgs, serverArgs.parseServerServeArgs);
  assert.equal(cliServerArgs.parseServerEnvArgs, serverArgs.parseServerEnvArgs);
});

test('canonical server sync args supports management-key alias and normalizes url', () => {
  const parsed = cliServerArgs.parseServerSyncArgs([
    '--management-url', 'http://127.0.0.1:8317/v0/management/',
    '--management-key', 'mgmt-key',
    '--parallel', '99'
  ]);

  assert.equal(parsed.managementUrl, 'http://127.0.0.1:8317/v0/management');
  assert.equal(parsed.key, 'mgmt-key');
  assert.equal(parsed.parallel, 32);
});
