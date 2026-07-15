const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectCodexClientVersion,
  parseCodexClientVersion,
  resolveCodexCommand
} = require('../lib/server/codex-client-version');

test('parseCodexClientVersion extracts semver from codex --version output', () => {
  assert.equal(parseCodexClientVersion('codex-cli 0.130.0'), '0.130.0');
  assert.equal(parseCodexClientVersion('0.129.1'), '0.129.1');
  assert.equal(parseCodexClientVersion('not a version'), '');
});

test('detectCodexClientVersion prefers configured environment override', () => {
  assert.equal(detectCodexClientVersion({
    processObj: {
      env: {
        AIH_SERVER_CODEX_CLIENT_VERSION: 'codex-cli 0.131.0'
      }
    },
    codexCommand: '/missing/codex'
  }), '0.131.0');
});

test('detectCodexClientVersion runs codex command once during startup probing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-version-'));
  const scriptPath = path.join(root, 'codex');
  try {
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho "codex-cli 0.130.0"\n', 'utf8');
    fs.chmodSync(scriptPath, 0o755);

    assert.equal(detectCodexClientVersion({
      codexCommand: scriptPath,
      processObj: { env: process.env },
      timeoutMs: 5000
    }), '0.130.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodexCommand prefers explicit path, env path, then resolver', () => {
  assert.equal(resolveCodexCommand({ codexCommand: '/tmp/codex-a' }), '/tmp/codex-a');
  assert.equal(resolveCodexCommand({
    processObj: { env: { AIH_CODEX_BIN: '/tmp/codex-b' } },
    resolveCliPath: () => '/tmp/codex-c'
  }), '/tmp/codex-b');
  assert.equal(resolveCodexCommand({
    processObj: { env: {} },
    resolveCliPath: () => '/tmp/codex-c'
  }), '/tmp/codex-c');
});
