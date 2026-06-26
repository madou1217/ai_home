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
    helperScriptPath: '/tmp/codex-proxy.js',
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
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
  assert.equal(state.providerHookReceiverUrl, 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook');
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
    helperScriptPath: '/tmp/codex-proxy.js',
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
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
    helperScriptPath: '/tmp/codex-proxy.js',
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
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
    helperScriptPath: '/tmp/codex-proxy.js',
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
  });

  service.activate();
  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  const initialState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath, JSON.stringify({
    ...initialState,
    desktopAccountId: '10009'
  }), 'utf8');
  service.updateTraceConfig({
    traceFile: '/tmp/codex-app-server-trace.jsonl',
    traceResponses: true,
    traceRemoteControl: true,
    remoteControlProxy: true
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
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(state.providerHookReceiverUrl, 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook');
  assert.equal(state.desktopAccountId, '10009');
});

test('codex desktop hook setDesktopAccountId preserves existing state settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-mobile-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    enabled: true,
    bundlePath: '/Applications/Codex.app',
    targetBinaryPath: '/Applications/Codex.app/Contents/Resources/codex',
    upstreamBinaryPath: '/Applications/Codex.app/Contents/Resources/codex.aih-original',
    traceFile: '/tmp/codex-trace.jsonl',
    traceResponses: true,
    traceRemoteControl: true,
    remoteControlProxy: true,
    desktopAccountId: '10001'
  }, null, 2), 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 603, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root
  });
  const result = service.setDesktopAccountId('10009');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.desktopAccountId, '10009');
  assert.equal(service.getDesktopAccountId(), '10009');
  assert.equal(state.enabled, true);
  assert.equal(state.bundlePath, '/Applications/Codex.app');
  assert.equal(state.traceFile, '/tmp/codex-trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(state.desktopAccountId, '10009');
});

test('codex desktop hook clearDesktopAccountId removes current id and preserves existing state settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-mobile-clear-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    enabled: true,
    bundlePath: '/Applications/Codex.app',
    targetBinaryPath: '/Applications/Codex.app/Contents/Resources/codex',
    upstreamBinaryPath: '/Applications/Codex.app/Contents/Resources/codex.aih-original',
    traceFile: '/tmp/codex-trace.jsonl',
    traceResponses: true,
    traceRemoteControl: true,
    remoteControlProxy: true,
    desktopAccountId: '10009'
  }, null, 2), 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 606, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root
  });
  const result = service.clearDesktopAccountId('10009');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.desktopAccountId, '');
  assert.equal(service.getDesktopAccountId(), '');
  assert.equal(state.enabled, true);
  assert.equal(state.bundlePath, '/Applications/Codex.app');
  assert.equal(state.traceFile, '/tmp/codex-trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'desktopAccountId'), false);
});

test('codex desktop hook clearDesktopAccountId keeps another current id when expected id differs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-mobile-clear-mismatch-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    enabled: true,
    traceFile: '/tmp/codex-trace.jsonl',
    remoteControlProxy: true,
    desktopAccountId: '10009'
  }, null, 2), 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 607, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root
  });
  const result = service.clearDesktopAccountId('10010');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.desktopAccountId, '10009');
  assert.equal(service.getDesktopAccountId(), '10009');
  assert.equal(state.desktopAccountId, '10009');
  assert.equal(state.traceFile, '/tmp/codex-trace.jsonl');
  assert.equal(state.remoteControlProxy, true);
});

test('codex desktop hook defaults remote trace file and restarts running app-servers on demand', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-restart-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  const killed = [];
  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: {
      pid: 604,
      platform: 'darwin',
      kill(pid, signal) {
        killed.push({ pid, signal });
      }
    },
    spawnSync(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-axo', 'pid=,command=']);
      return {
        status: 0,
        stdout: [
          ` 701 /usr/local/bin/node /tmp/codex-proxy.js --state-file ${path.join(aiHomeDir, 'codex-desktop-hook-state.json')} -- app-server --listen stdio://`,
          ` 702 ${targetBinaryPath}.aih-original app-server --listen stdio://`,
          ' 703 /usr/local/bin/node something-else'
        ].join('\n')
      };
    },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  service.activate();
  const traceUpdate = service.updateTraceConfig({
    traceRemoteControl: true,
    remoteControlProxy: true
  });
  const restart = service.restartRunningAppServers();
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));

  assert.equal(traceUpdate.changed, true);
  assert.equal(traceUpdate.traceFile, path.join(aiHomeDir, 'codex-mobile-trace.jsonl'));
  assert.equal(state.traceFile, path.join(aiHomeDir, 'codex-mobile-trace.jsonl'));
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.deepEqual(restart.pids, [701, 702]);
  assert.deepEqual(killed, [
    { pid: 701, signal: 'SIGTERM' },
    { pid: 702, signal: 'SIGTERM' }
  ]);
});

test('codex desktop hook marks trace config changed when helper code changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-helper-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  const helperScriptPath = path.join(root, 'codex-proxy.js');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.writeFileSync(helperScriptPath, 'module.exports = 1;\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 605, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath
  });

  service.activate();
  const firstUpdate = service.updateTraceConfig({
    traceRemoteControl: true,
    remoteControlProxy: true
  });
  const secondUpdate = service.updateTraceConfig({
    traceRemoteControl: true,
    remoteControlProxy: true
  });
  const future = new Date(Date.now() + 10_000);
  fs.writeFileSync(helperScriptPath, 'module.exports = 2;\n', 'utf8');
  fs.utimesSync(helperScriptPath, future, future);
  const thirdUpdate = service.updateTraceConfig({
    traceRemoteControl: true,
    remoteControlProxy: true
  });

  assert.equal(firstUpdate.changed, true);
  assert.equal(secondUpdate.changed, false);
  assert.equal(thirdUpdate.changed, true);
});
