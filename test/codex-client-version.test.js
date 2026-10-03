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

test('codex client version never reports below the verified floor and is cached', () => {
  const {
    CODEX_CLIENT_VERSION_FLOOR,
    atLeastCodexClientVersionFloor,
    compareCodexClientVersions,
    getCodexClientVersion,
    resetCodexClientVersionCacheForTest
  } = require('../lib/server/codex-client-version');
  assert.equal(atLeastCodexClientVersionFloor('codex-cli 0.154.0-alpha.3'), CODEX_CLIENT_VERSION_FLOOR);
  assert.equal(atLeastCodexClientVersionFloor(''), CODEX_CLIENT_VERSION_FLOOR);
  assert.equal(atLeastCodexClientVersionFloor('codex-cli 0.170.2'), '0.170.2');
  assert.equal(compareCodexClientVersions('1.10.0', '1.9.9'), 1);
  resetCodexClientVersionCacheForTest();
  let now = 0;
  const first = getCodexClientVersion({ codexClientVersion: '0.171.0', now: () => now });
  now += 1000;
  const cachedValue = getCodexClientVersion({ codexClientVersion: '0.172.0', now: () => now });
  now += 60 * 60 * 1000;
  const refreshed = getCodexClientVersion({ codexClientVersion: '0.172.0', now: () => now });
  assert.deepEqual([first, cachedValue, refreshed], ['0.171.0', '0.171.0', '0.172.0']);
  resetCodexClientVersionCacheForTest();
});

test('Windows resolves the codex .cmd shim before probing the version', () => {
  // execFileSync 直接执行 .cmd 在 Windows 上 EINVAL，探测永远失败 → 自报最低版本，新模型被上游拒。
  const calls = [];
  const version = detectCodexClientVersion({
    platform: 'win32',
    processObj: { env: {} },
    resolveCliPath: () => 'C:\\nvm\\codex.cmd',
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
      return 'codex-cli 0.159.2\n';
    }
  });
  assert.equal(version, '0.159.2');
  assert.notEqual(calls[0].command, 'C:\\nvm\\codex.cmd');
  assert.equal(calls[0].options.timeout, 5000);
});
