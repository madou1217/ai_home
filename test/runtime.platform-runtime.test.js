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

test('resolveCliPath chooses highest claude version from PATH candidates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldClaude = path.join(oldDir, 'claude');
  const newClaude = path.join(newDir, 'claude');
  fs.writeFileSync(oldClaude, '#!/bin/sh\n', 'utf8');
  fs.writeFileSync(newClaude, '#!/bin/sh\n', 'utf8');
  fs.chmodSync(oldClaude, 0o755);
  fs.chmodSync(newClaude, 0o755);

  const resolved = resolveCliPath('claude', {
    platform: 'darwin',
    env: { PATH: `${oldDir}:${newDir}` },
    spawnSyncImpl: (cmd) => ({
      stdout: cmd === newClaude ? '2.1.148 (Claude Code)' : '2.1.141 (Claude Code)',
      stderr: ''
    })
  });

  assert.equal(resolved, newClaude);
});

test('resolveCliPath chooses highest opencode version from PATH candidates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldOpenCode = path.join(oldDir, 'opencode');
  const newOpenCode = path.join(newDir, 'opencode');
  fs.writeFileSync(oldOpenCode, '#!/bin/sh\n', 'utf8');
  fs.writeFileSync(newOpenCode, '#!/bin/sh\n', 'utf8');
  fs.chmodSync(oldOpenCode, 0o755);
  fs.chmodSync(newOpenCode, 0o755);

  const resolved = resolveCliPath('opencode', {
    platform: 'darwin',
    env: { PATH: `${oldDir}:${newDir}` },
    spawnSyncImpl: (cmd) => ({
      stdout: cmd === newOpenCode ? '1.17.8' : '1.4.7',
      stderr: ''
    })
  });

  assert.equal(resolved, newOpenCode);
});

test('resolveCliPath respects AIH_CLAUDE_RESOLVE_LATEST=0', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-path-disable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldClaude = path.join(oldDir, 'claude');
  const newClaude = path.join(newDir, 'claude');
  fs.writeFileSync(oldClaude, '#!/bin/sh\n', 'utf8');
  fs.writeFileSync(newClaude, '#!/bin/sh\n', 'utf8');
  fs.chmodSync(oldClaude, 0o755);
  fs.chmodSync(newClaude, 0o755);

  const resolved = resolveCliPath('claude', {
    platform: 'darwin',
    env: {
      PATH: `${oldDir}:${newDir}`,
      AIH_CLAUDE_RESOLVE_LATEST: '0'
    },
    spawnSyncImpl: () => {
      throw new Error('version probe should be disabled');
    }
  });

  assert.equal(resolved, oldClaude);
});

test('commandExists returns false for non-existent command', () => {
  assert.equal(commandExists('definitely-not-a-real-command-xyz'), false);
});
