const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexDesktopHookService
} = require('../lib/server/codex-desktop-hook');

test('buildWrapperScript renders stable codex desktop wrapper', () => {
  const script = buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/helper.js',
    upstreamBinaryPath: '/Applications/Codex.app/Contents/Resources/codex.aih-original',
    stateFilePath: '/tmp/codex-hook-state.json'
  });
  assert.equal(script.includes(WRAPPER_MARKER), true);
  assert.equal(script.includes('/tmp/helper.js'), true);
  assert.equal(script.includes('app-server'), true);
});

test('codex desktop hook activates by installing wrapper and enabling state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 501, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  const result = service.activate();
  const wrapper = fs.readFileSync(targetBinaryPath, 'utf8');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(fs.existsSync(upstreamBinaryPath), true);
  assert.equal(wrapper.includes(WRAPPER_MARKER), true);
  assert.equal(wrapper.includes('/tmp/codex-proxy.js'), true);
  assert.equal(state.enabled, true);
});

test('codex desktop hook activate does not terminate running app-server processes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const signals = [];
  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: {
      pid: 502,
      platform: 'darwin',
      kill(pid, signal) {
        signals.push({ pid, signal });
      }
    },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  const result = service.activate();
  assert.equal(result.ok, true);
  assert.deepEqual(signals, []);
});

test('codex desktop hook deactivates by flipping shared state only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 601, platform: 'darwin', kill() {} },
    spawnSync: () => ({ status: 0, stdout: '' }),
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  service.activate();
  const result = service.deactivate();
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(state.enabled, false);
});

test('codex desktop hook ensureInstalled repairs overwritten wrapper and preserves trace config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 602, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  service.activate();
  service.updateTraceConfig({
    traceFile: '/tmp/codex-app-server-trace.jsonl',
    traceResponses: true
  });

  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho overwritten-runtime\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const result = service.ensureInstalled();
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(`${targetBinaryPath}.aih-original`, 'utf8'), '#!/bin/sh\necho overwritten-runtime\n');
  assert.equal(state.traceFile, '/tmp/codex-app-server-trace.jsonl');
  assert.equal(state.traceResponses, true);
});
