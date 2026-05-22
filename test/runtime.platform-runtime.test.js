const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  commandExists,
  configureConsoleEncoding,
  parseCliVersion,
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

test('parseCliVersion extracts codex cli semantic version', () => {
  assert.deepEqual(parseCliVersion('codex-cli 0.132.0'), {
    major: 0,
    minor: 132,
    patch: 0,
    raw: '0.132.0'
  });
});

test('resolveCliPath chooses highest codex version from PATH candidates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldCodex = path.join(oldDir, 'codex');
  const newCodex = path.join(newDir, 'codex');
  fs.writeFileSync(oldCodex, '#!/bin/sh\n', 'utf8');
  fs.writeFileSync(newCodex, '#!/bin/sh\n', 'utf8');
  fs.chmodSync(oldCodex, 0o755);
  fs.chmodSync(newCodex, 0o755);

  const resolved = resolveCliPath('codex', {
    platform: 'darwin',
    env: { PATH: `${oldDir}:${newDir}` },
    spawnSyncImpl: (cmd) => ({
      stdout: cmd === newCodex ? 'codex-cli 0.132.0' : 'codex-cli 0.130.0',
      stderr: ''
    })
  });

  assert.equal(resolved, newCodex);
});

test('commandExists returns false for non-existent command', () => {
  assert.equal(commandExists('definitely-not-a-real-command-xyz'), false);
});
