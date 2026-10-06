'use strict';

// codex CLI hook 自愈循环（15 秒一轮）解析 codex 路径的节流约定：
//   - PATH 扫描每轮照做；
//   - 登录 shell 回落（一次子进程 + 整套 profile）在后台轮询里按 BACKGROUND_FULL_RESOLVE_INTERVAL_MS 复用结论；
//   - 显式调用（启动 activate、升级后 ensureInstalled()）永远完整解析。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BACKGROUND_FULL_RESOLVE_INTERVAL_MS,
  createCodexCliHookService
} = require('../lib/server/codex-cli-hook');

function setup(t, resolveImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-bg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const calls = { scan: 0, full: 0 };
  let clock = 1_000_000;
  const stateWrites = [];
  const trackedFs = {
    ...fs,
    writeFileSync(filePath, ...rest) {
      if (String(filePath).endsWith('cli-hook-state.json')) stateWrites.push(String(rest[0]));
      return fs.writeFileSync(filePath, ...rest);
    }
  };
  const service = createCodexCliHookService({
    fs: trackedFs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    now: () => clock,
    resolveCliPath: (name, options = {}) => {
      if (options.loginShellFallback === false) {
        calls.scan += 1;
        return resolveImpl.scan(name);
      }
      calls.full += 1;
      return resolveImpl.full(name);
    }
  });
  return { root, service, calls, stateWrites, advance: (ms) => { clock += ms; } };
}

function writeFakeCodex(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
}

test('codex missing: background ticks run the login-shell fallback once per window', (t) => {
  const { service, calls, advance } = setup(t, { scan: () => '', full: () => '' });

  for (let i = 0; i < 10; i += 1) {
    service.ensureInstalled({ background: true });
    advance(15_000);
  }
  assert.equal(calls.scan, 10, 'the cheap PATH scan still runs every tick');
  assert.equal(calls.full, 1);

  advance(BACKGROUND_FULL_RESOLVE_INTERVAL_MS);
  service.ensureInstalled({ background: true });
  assert.equal(calls.full, 2);
});

test('startup activation seeds the background memo', (t) => {
  const { service, calls } = setup(t, { scan: () => '', full: () => '' });

  service.activate();
  service.ensureInstalled({ background: true });
  service.ensureInstalled({ background: true });

  assert.equal(calls.full, 1);
});

test('explicit ensureInstalled always resolves fully, bypassing a fresh miss', (t) => {
  const { service, calls } = setup(t, { scan: () => '', full: () => '' });

  service.ensureInstalled({ background: true });
  service.ensureInstalled();
  service.ensureInstalled();

  assert.equal(calls.full, 3);
});

test('found by PATH scan: background ticks never spawn the login shell', (t) => {
  const box = {};
  const { root, service, calls } = setup(t, { scan: () => box.codex, full: () => box.codex });
  box.codex = path.join(root, 'bin', 'codex');
  writeFakeCodex(box.codex);

  for (let i = 0; i < 5; i += 1) service.ensureInstalled({ background: true });

  assert.equal(calls.full, 0);
  assert.equal(calls.scan, 5);
});

test('found only via the login shell: the path is reused while it exists', (t) => {
  const box = {};
  const { root, service, calls } = setup(t, { scan: () => '', full: () => (fs.existsSync(box.codex) ? box.codex : '') });
  box.codex = path.join(root, 'nvm', 'bin', 'codex');
  writeFakeCodex(box.codex);

  const first = service.ensureInstalled({ background: true });
  for (let i = 0; i < 4; i += 1) service.ensureInstalled({ background: true });
  assert.equal(calls.full, 1);
  assert.equal(first.targetBinaryPath, box.codex);

  fs.rmSync(path.join(root, 'nvm'), { recursive: true, force: true });
  service.ensureInstalled({ background: true });
  assert.equal(calls.full, 2, 'a vanished path is re-resolved on the next tick');
});

test('the state file is rewritten only when the hook state changes', (t) => {
  const box = { codex: '' };
  const { root, service, stateWrites } = setup(t, { scan: () => box.codex, full: () => box.codex });

  for (let i = 0; i < 5; i += 1) service.ensureInstalled({ background: true });
  assert.equal(stateWrites.length, 1, 'repeated identical not-found ticks write once');
  assert.equal(JSON.parse(stateWrites[0]).reason, 'codex_cli_not_found');

  box.codex = path.join(root, 'bin', 'codex');
  writeFakeCodex(box.codex);
  service.ensureInstalled({ background: true });
  assert.equal(stateWrites.length, 2, 'installing codex changes the state and is persisted');
  assert.equal(JSON.parse(stateWrites[1]).enabled, true);
  const after = stateWrites.length;
  service.ensureInstalled({ background: true });
  service.ensureInstalled({ background: true });
  assert.equal(stateWrites.length, after, 'a healthy unchanged hook is not rewritten');
});
