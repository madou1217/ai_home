const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexCliHookService
} = require('../lib/server/codex-cli-hook');

test('buildWrapperScript renders stable codex cli wrapper', () => {
  const script = buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/helper.js',
    upstreamBinaryPath: '/tmp/codex.aih-original',
    stateFilePath: '/tmp/codex-hook-state.json'
  });
  assert.equal(script.includes(WRAPPER_MARKER), true);
  assert.equal(script.includes('/tmp/helper.js'), true);
  assert.equal(script.includes('app-server'), true);
});

test('codex cli hook activates by installing wrapper and enabling state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.activate();
  const wrapper = fs.readFileSync(targetBinaryPath, 'utf8');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-cli-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(fs.existsSync(upstreamBinaryPath), true);
  assert.equal(fs.readFileSync(upstreamBinaryPath, 'utf8'), '#!/bin/sh\necho original\n');
  assert.equal(wrapper.includes(WRAPPER_MARKER), true);
  assert.equal(wrapper.includes('/tmp/codex-proxy.js'), true);
  assert.equal(state.enabled, true);
});

test('codex cli hook refreshes upstream snapshot when global shim was overwritten by upgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho upgraded\n', 'utf8');
  fs.writeFileSync(upstreamBinaryPath, '#!/bin/sh\necho stale\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  fs.chmodSync(upstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.activate();

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(upstreamBinaryPath, 'utf8'), '#!/bin/sh\necho upgraded\n');
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
});

test('codex cli hook preserves .js suffix for node-entry symlink backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const libDir = path.join(root, 'lib');
  const targetBinaryPath = path.join(binDir, 'codex');
  const targetEntryPath = path.join(libDir, 'codex.js');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetEntryPath, '#!/usr/bin/env node\nconsole.log("original")\n', 'utf8');
  fs.chmodSync(targetEntryPath, 0o755);
  fs.symlinkSync(targetEntryPath, targetBinaryPath);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.activate();
  const expectedUpstreamBinaryPath = path.join(fs.realpathSync(libDir), 'codex.aih-original.js');

  assert.equal(result.ok, true);
  assert.equal(result.upstreamBinaryPath, expectedUpstreamBinaryPath);
  assert.equal(fs.existsSync(expectedUpstreamBinaryPath), true);
  assert.equal(fs.readFileSync(expectedUpstreamBinaryPath, 'utf8'), '#!/usr/bin/env node\nconsole.log("original")\n');
});

test('codex cli hook migrates legacy node-entry backup from target shim path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const libDir = path.join(root, 'lib');
  const targetBinaryPath = path.join(binDir, 'codex');
  const targetEntryPath = path.join(libDir, 'codex.js');
  const legacyUpstreamBinaryPath = `${targetBinaryPath}.aih-original.js`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetEntryPath, '#!/bin/sh\n# aih-codex-cli-hook\nexec echo wrapped\n', 'utf8');
  const expectedUpstreamBinaryPath = path.join(path.dirname(fs.realpathSync(targetEntryPath)), 'codex.aih-original.js');
  fs.symlinkSync(targetEntryPath, targetBinaryPath);
  fs.writeFileSync(legacyUpstreamBinaryPath, '#!/usr/bin/env node\nconsole.log("legacy")\n', 'utf8');
  fs.chmodSync(targetEntryPath, 0o755);
  fs.chmodSync(legacyUpstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.ensureInstalled();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.existsSync(expectedUpstreamBinaryPath), true);
  assert.equal(fs.readFileSync(expectedUpstreamBinaryPath, 'utf8'), '#!/usr/bin/env node\nconsole.log("legacy")\n');
  assert.equal(fs.existsSync(legacyUpstreamBinaryPath), false);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(expectedUpstreamBinaryPath), true);
});

test('codex cli hook deactivates by flipping shared state only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  service.activate();
  const result = service.deactivate();
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-cli-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(state.enabled, false);
});

test('codex cli hook ensureInstalled repairs overwritten shim only when drift is detected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const first = service.ensureInstalled();
  assert.equal(first.repaired, true);
  const healthy = service.ensureInstalled();
  assert.equal(healthy.repaired, false);

  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho overwritten\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  const repaired = service.ensureInstalled();
  assert.equal(repaired.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(`${targetBinaryPath}.aih-original`, 'utf8'), '#!/bin/sh\necho overwritten\n');
});

test('codex cli hook ensureInstalled refreshes stale wrapper content when upstream path changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const libDir = path.join(root, 'lib');
  const targetBinaryPath = path.join(binDir, 'codex');
  const targetEntryPath = path.join(libDir, 'codex.js');
  const legacyUpstreamBinaryPath = `${targetBinaryPath}.aih-original.js`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetEntryPath, '#!/bin/sh\n# aih-codex-cli-hook\nUPSTREAM=\'/tmp/old-codex.aih-original.js\'\nexec echo wrapped\n', 'utf8');
  const expectedUpstreamBinaryPath = path.join(path.dirname(fs.realpathSync(targetEntryPath)), 'codex.aih-original.js');
  fs.symlinkSync(targetEntryPath, targetBinaryPath);
  fs.writeFileSync(legacyUpstreamBinaryPath, '#!/usr/bin/env node\nconsole.log("legacy")\n', 'utf8');
  fs.chmodSync(targetEntryPath, 0o755);
  fs.chmodSync(legacyUpstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.ensureInstalled();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(expectedUpstreamBinaryPath), true);
  assert.equal(fs.existsSync(expectedUpstreamBinaryPath), true);
  assert.equal(fs.existsSync(legacyUpstreamBinaryPath), false);
});
