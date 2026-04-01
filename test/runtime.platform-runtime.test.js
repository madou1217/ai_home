const test = require('node:test');
const assert = require('node:assert/strict');

const {
  commandExists,
  configureConsoleEncoding,
  resolveCliPath
} = require('../lib/runtime/platform-runtime');

test('configureConsoleEncoding enables UTF-8 on win32 via chcp', () => {
  const calls = [];
  const stdoutCalls = [];
  const stderrCalls = [];
  configureConsoleEncoding({
    platform: 'win32',
    spawnSyncImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0 };
    },
    stdout: { setDefaultEncoding: (enc) => stdoutCalls.push(enc) },
    stderr: { setDefaultEncoding: (enc) => stderrCalls.push(enc) }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', 'chcp 65001>nul']);
  assert.deepEqual(stdoutCalls, ['utf8']);
  assert.deepEqual(stderrCalls, ['utf8']);
});

test('configureConsoleEncoding no-op on non-win32', () => {
  let called = false;
  configureConsoleEncoding({
    platform: 'linux',
    spawnSyncImpl: () => {
      called = true;
      return { status: 0 };
    }
  });
  assert.equal(called, false);
});

test('resolveCliPath delegates to cross-platform command resolver', () => {
  const out = resolveCliPath('node');
  assert.equal(typeof out, 'string');
  assert.notEqual(out, '');
});

test('commandExists returns false for non-existent command', () => {
  assert.equal(commandExists('definitely-not-a-real-command-xyz'), false);
});

