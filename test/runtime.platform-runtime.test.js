const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('resolveCliPath uses the first PATH match for every provider without version probes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-default-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultDir = path.join(root, 'default');
  const laterDir = path.join(root, 'later');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(laterDir, { recursive: true });
  let probes = 0;

  for (const provider of ['codex', 'claude', 'opencode']) {
    const defaultPath = path.join(defaultDir, provider);
    const laterPath = path.join(laterDir, provider);
    fs.writeFileSync(defaultPath, '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(laterPath, '#!/bin/sh\n', 'utf8');
    fs.chmodSync(defaultPath, 0o755);
    fs.chmodSync(laterPath, 0o755);

    assert.equal(resolveCliPath(provider, {
      platform: 'darwin',
      env: { PATH: `${defaultDir}:${laterDir}` },
      spawnSyncImpl: () => {
        probes += 1;
        throw new Error('the selected PATH entry must not require a version probe');
      }
    }), defaultPath);
  }
  assert.equal(probes, 0);
});

test('commandExists returns false for non-existent command', () => {
  assert.equal(commandExists('definitely-not-a-real-command-xyz'), false);
});
