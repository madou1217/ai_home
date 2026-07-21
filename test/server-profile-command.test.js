'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  formatServerProfileResult,
  runServerProfileCommand
} = require('../lib/cli/services/server/profile-command');
const { runServerCommand } = require('../lib/server/command-handler');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-profile-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { fs, aiHomeDir };
}

test('server add stores one Management Key profile and never returns the secret', (t) => {
  const deps = createFixture(t);
  const result = runServerProfileCommand('add', [
    'aws',
    '--url',
    'https://aws.example.com/ui/',
    '--management-key',
    'management-secret'
  ], deps);

  assert.equal(result.ok, true);
  assert.equal(result.profile.name, 'aws');
  assert.equal(result.profile.endpoint, 'https://aws.example.com');
  assert.equal(result.profile.state, 'ready');
  assert.equal(result.profile.active, true);
  assert.equal(result.profile.managementKeyConfigured, true);
  assert.equal(JSON.stringify(result).includes('management-secret'), false);

  const listed = runServerProfileCommand('ls', [], deps);
  assert.equal(listed.profiles.length, 1);
  assert.equal(listed.profiles[0].active, true);
  assert.equal(formatServerProfileResult(listed).includes('management-secret'), false);
});

test('server use and remove resolve profiles by name without exposing keys', (t) => {
  const deps = createFixture(t);
  runServerProfileCommand('add', [
    'current', '--url', 'http://127.0.0.1:9527', '--management-key', 'current-key'
  ], deps);
  runServerProfileCommand('add', [
    'aws', '--url', 'https://aws.example.com', '--management-key', 'aws-key'
  ], deps);

  const selected = runServerProfileCommand('use', ['current'], deps);
  assert.equal(selected.profile.name, 'current');
  assert.equal(selected.profile.active, true);

  const removed = runServerProfileCommand('remove', ['aws'], deps);
  assert.equal(removed.removed.name, 'aws');
  const listed = runServerProfileCommand('list', ['--json'], deps);
  assert.equal(listed.json, true);
  assert.deepEqual(listed.profiles.map((profile) => profile.name), ['current']);
  assert.equal(JSON.stringify(listed).includes('current-key'), false);
  assert.equal(JSON.stringify(listed).includes('aws-key'), false);
});

test('server add requires an explicit Management Key', (t) => {
  const deps = createFixture(t);
  assert.throws(
    () => runServerProfileCommand('add', ['aws', '--url', 'https://aws.example.com'], deps),
    (error) => error && error.code === 'missing_management_key'
  );
});

test('server command dispatches profile actions before daemon lifecycle actions', async () => {
  const calls = [];
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const code = await runServerCommand(['server', 'ls', '--json'], {
      showServerUsage() {},
      serverDaemon: {},
      runServerProfileCommand(action, args) {
        calls.push({ action, args });
        return { ok: true, json: true, action: 'list', activeProfileId: '', profiles: [] };
      },
      formatServerProfileResult
    });
    assert.equal(code, 0);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(calls, [{ action: 'ls', args: ['--json'] }]);
  assert.deepEqual(JSON.parse(logs.join('\n')).profiles, []);
});
