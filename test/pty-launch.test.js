const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../lib/runtime/pty-launch');

test('buildPtyLaunch keeps direct launch on linux', () => {
  const launch = buildPtyLaunch('/usr/local/bin/codex', ['--help'], { platform: 'linux' });
  assert.equal(launch.command, '/usr/local/bin/codex');
  assert.deepEqual(launch.args, ['--help']);
});

test('buildPtyLaunch wraps .cmd with cmd.exe on windows', () => {
  const launch = buildPtyLaunch(
    'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    ['--sandbox', 'danger-full-access'],
    { platform: 'win32' }
  );
  assert.equal(launch.command, 'cmd.exe');
  assert.equal(launch.args[0], '/d');
  assert.equal(launch.args[1], '/s');
  assert.equal(launch.args[2], '/c');
  assert.match(launch.args[3], /codex\.cmd/);
  assert.match(launch.args[3], /--sandbox/);
});

test('buildPtyLaunch wraps extensionless command with cmd.exe on windows', () => {
  const launch = buildPtyLaunch('codex', ['login'], { platform: 'win32' });
  assert.equal(launch.command, 'cmd.exe');
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(launch.args[3], 'chcp 65001>nul & codex login');
});

test('buildPtyLaunch keeps native exe direct on windows', () => {
  const launch = buildPtyLaunch(
    'C:\\Program Files\\OpenAI\\codex.exe',
    ['--version'],
    { platform: 'win32' }
  );
  assert.equal(launch.command, 'C:\\Program Files\\OpenAI\\codex.exe');
  assert.deepEqual(launch.args, ['--version']);
});

test('resolveWindowsBatchLaunch injects cmd directory into PATH and uses basename', () => {
  const resolved = resolveWindowsBatchLaunch(
    'codex',
    'D:\\nvm4w\\nodejs\\codex.cmd',
    { Path: 'C:\\Windows\\System32' },
    'win32'
  );
  assert.equal(resolved.launchBin, 'codex');
  assert.match(resolved.envPatch.Path, /D:\\nvm4w\\nodejs/i);
  assert.equal(resolved.envPatch.Path, resolved.envPatch.PATH);
});
