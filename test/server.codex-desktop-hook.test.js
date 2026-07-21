const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('codex desktop wrapper proxies app-server after global config options', {
  skip: process.platform === 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-wrapper-dispatch-'));
  const wrapperPath = path.join(root, 'codex');
  const nodePath = path.join(root, 'node');
  const upstreamPath = path.join(root, 'codex.aih-original');
  const capturePath = path.join(root, 'args.txt');
  const helperPath = path.join(root, 'helper.js');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(nodePath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${capturePath}'\n`, 'utf8');
  fs.writeFileSync(upstreamPath, '#!/bin/sh\nexit 91\n', 'utf8');
  fs.writeFileSync(wrapperPath, buildWrapperScript({
    nodeExecPath: nodePath,
    helperScriptPath: helperPath,
    upstreamBinaryPath: upstreamPath,
    stateFilePath: statePath
  }), 'utf8');
  fs.chmodSync(nodePath, 0o755);
  fs.chmodSync(upstreamPath, 0o755);
  fs.chmodSync(wrapperPath, 0o755);

  const result = spawnSync(wrapperPath, [
    '-c',
    'features.code_mode_host=true',
    'app-server',
    '--analytics-default-enabled'
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(capturePath, 'utf8').trim().split('\n'), [
    helperPath,
    '--upstream',
    upstreamPath,
    '--state-file',
    statePath,
    '--',
    '-c',
    'features.code_mode_host=true',
    'app-server',
    '--analytics-default-enabled'
  ]);

  const execResult = spawnSync(wrapperPath, ['exec', 'app-server'], { encoding: 'utf8' });
  assert.equal(execResult.status, 91);
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
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(fs.existsSync(upstreamBinaryPath), true);
  assert.equal(wrapper.includes(WRAPPER_MARKER), true);
  assert.equal(wrapper.includes('/tmp/codex-proxy.js'), true);
  assert.equal(state.enabled, true);
  assert.equal(state.providerHookReceiverUrl, 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook');
});

test('codex desktop hook activation does not rewrite a current wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-idempotent-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const options = {
    path,
    processObj: { pid: 502, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  };
  createCodexDesktopHookService({ fs, ...options }).activate();

  const backgroundFs = {
    ...fs,
    writeFileSync(filePath, ...args) {
      if (filePath === targetBinaryPath) {
        const error = new Error('background process cannot modify app bundle');
        error.code = 'EPERM';
        throw error;
      }
      return fs.writeFileSync(filePath, ...args);
    }
  };
  const result = createCodexDesktopHookService({ fs: backgroundFs, ...options }).activate();

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.updated, false);
  assert.equal(result.installed, true);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'),
    'utf8'
  )).enabled, true);
});

test('codex desktop hook discovers the merged ChatGPT app by its bundled codex runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chatgpt-codex-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'ChatGPT.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho merged-chatgpt-runtime\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 511, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  const result = service.activate();

  assert.equal(result.ok, true);
  assert.equal(result.bundlePath, bundlePath);
  assert.equal(result.targetBinaryPath, targetBinaryPath);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(`${targetBinaryPath}.aih-original`, 'utf8').includes('merged-chatgpt-runtime'), true);
});

test('codex desktop hook ignores a ChatGPT bundle without the codex runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chatgpt-no-codex-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const chatGptBundle = path.join(root, 'Applications', 'ChatGPT.app');
  const codexBundle = path.join(root, 'Applications', 'Codex.app');
  const codexResources = path.join(codexBundle, 'Contents', 'Resources');
  fs.mkdirSync(path.join(chatGptBundle, 'Contents', 'Resources'), { recursive: true });
  fs.mkdirSync(codexResources, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(path.join(codexResources, 'codex'), '#!/bin/sh\necho codex\n', 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 512, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  assert.equal(service.resolvePaths().bundlePath, codexBundle);
});

test('codex desktop hook can restart a pre-wrapper ChatGPT app-server process', () => {
  const targetBinaryPath = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const stateFilePath = '/tmp/.ai_home/run/codex/desktop-hook-state.json';
  const killed = [];
  const service = createCodexDesktopHookService({
    fs: {
      existsSync: () => true,
      readFileSync(filePath) {
        if (filePath === stateFilePath) {
          return JSON.stringify({
            enabled: true,
            bundlePath: '/Applications/ChatGPT.app',
            targetBinaryPath,
            upstreamBinaryPath: `${targetBinaryPath}.aih-original`
          });
        }
        return '';
      }
    },
    path,
    processObj: {
      pid: 513,
      platform: 'darwin',
      kill(pid, signal) {
        killed.push({ pid, signal });
      }
    },
    spawnSync: () => ({
      status: 0,
      stdout: [
        ' 81300 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
        ` 81315 81300 ${targetBinaryPath} -c features.code_mode_host=true app-server --analytics-default-enabled`
      ].join('\n')
    }),
    aiHomeDir: '/tmp/.ai_home',
    hostHomeDir: '/Users/model',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  const result = service.restartRunningAppServers();

  assert.deepEqual(result.pids, [81315]);
  assert.deepEqual(killed, [{ pid: 81315, signal: 'SIGTERM' }]);
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

test('codex desktop hook rejects an unwritable large binary without reading it into memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-large-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = path.join(root, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, Buffer.alloc(70 * 1024));
  let targetReads = 0;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'readFileSync') {
        return (filePath, ...args) => {
          if (filePath === targetBinaryPath) targetReads += 1;
          return fs.readFileSync(filePath, ...args);
        };
      }
      if (property === 'copyFileSync') {
        return () => {
          const error = new Error('operation not permitted');
          error.code = 'EPERM';
          throw error;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const service = createCodexDesktopHookService({
    fs: fsImpl,
    path,
    processObj: { pid: 503, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  const result = service.ensureInstalled();
  service.updateTraceConfig({
    traceRemoteControl: true,
    remoteControlProxy: true
  });
  const state = JSON.parse(fs.readFileSync(
    path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'),
    'utf8'
  ));

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, 'hook_target_not_writable');
  assert.equal(result.errorCode, 'EPERM');
  assert.equal(targetReads, 0);
  assert.equal(state.enabled, false);
  assert.equal(state.reason, 'hook_target_not_writable');
  assert.equal(state.retryable, false);
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
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(state.enabled, false);
});

test('codex desktop hook trace update does not mark empty Windows target enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-win-empty-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 607, platform: 'win32', kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
  });

  const result = service.updateTraceConfig({
    traceRemoteControl: true,
    remoteControlProxy: true
  });
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(state.enabled, false);
  assert.equal(state.targetBinaryPath, '');
  assert.equal(state.upstreamBinaryPath, '');
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
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
  const statePath = path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  const initialState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath, JSON.stringify({
    ...initialState,
    desktopAccountRef: 'acct_11111111111111111111'
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
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(`${targetBinaryPath}.aih-original`, 'utf8'), '#!/bin/sh\necho overwritten-runtime\n');
  assert.equal(state.traceFile, '/tmp/codex-app-server-trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(state.providerHookReceiverUrl, 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook');
  assert.equal(state.desktopAccountRef, 'acct_11111111111111111111');
});

test('codex desktop hook setDesktopAccountRef preserves existing state settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-mobile-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const statePath = path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
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
    desktopAccountRef: 'acct_11111111111111111111'
  }, null, 2), 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 603, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root
  });
  const result = service.setDesktopAccountRef('acct_22222222222222222222');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.desktopAccountRef, 'acct_22222222222222222222');
  assert.equal(service.getDesktopAccountRef(), 'acct_22222222222222222222');
  assert.equal(state.enabled, true);
  assert.equal(state.bundlePath, '/Applications/Codex.app');
  assert.equal(state.traceFile, '/tmp/codex-trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(state.desktopAccountRef, 'acct_22222222222222222222');
});

test('codex desktop hook clearDesktopAccountRef removes current ref and preserves existing state settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-mobile-clear-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const statePath = path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
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
    desktopAccountRef: 'acct_11111111111111111111'
  }, null, 2), 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 606, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root
  });
  const result = service.clearDesktopAccountRef('acct_11111111111111111111');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.desktopAccountRef, '');
  assert.equal(service.getDesktopAccountRef(), '');
  assert.equal(state.enabled, true);
  assert.equal(state.bundlePath, '/Applications/Codex.app');
  assert.equal(state.traceFile, '/tmp/codex-trace.jsonl');
  assert.equal(state.traceResponses, true);
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'desktopAccountRef'), false);
});

test('codex desktop hook clearDesktopAccountRef keeps another current ref when expected ref differs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-hook-mobile-clear-mismatch-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const statePath = path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    enabled: true,
    traceFile: '/tmp/codex-trace.jsonl',
    remoteControlProxy: true,
    desktopAccountRef: 'acct_11111111111111111111'
  }, null, 2), 'utf8');

  const service = createCodexDesktopHookService({
    fs,
    path,
    processObj: { pid: 607, platform: 'darwin', kill() {} },
    aiHomeDir,
    hostHomeDir: root
  });
  const result = service.clearDesktopAccountRef('acct_22222222222222222222');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.desktopAccountRef, 'acct_11111111111111111111');
  assert.equal(service.getDesktopAccountRef(), 'acct_11111111111111111111');
  assert.equal(state.desktopAccountRef, 'acct_11111111111111111111');
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
      assert.deepEqual(args, ['-axo', 'pid=,ppid=,command=']);
      return {
        status: 0,
        stdout: [
          ` 700 1 ${path.join(bundlePath, 'Contents', 'MacOS', 'Codex')}`,
          ` 701 700 /usr/local/bin/node /tmp/codex-proxy.js --state-file ${path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json')} -- app-server --listen stdio://`,
          ` 702 701 ${targetBinaryPath}.aih-original app-server --listen stdio://`,
          ' 703 700 /usr/local/bin/node something-else',
          ` 704 703 ${targetBinaryPath}.aih-original app-server --listen stdio://`
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
  const state = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'), 'utf8'));

  assert.equal(traceUpdate.changed, true);
  assert.equal(traceUpdate.traceFile, path.join(aiHomeDir, 'logs', 'codex', 'mobile-trace.jsonl'));
  assert.equal(state.traceFile, path.join(aiHomeDir, 'logs', 'codex', 'mobile-trace.jsonl'));
  assert.equal(state.traceRemoteControl, true);
  assert.equal(state.remoteControlProxy, true);
  assert.deepEqual(restart.pids, [701]);
  assert.deepEqual(killed, [{ pid: 701, signal: 'SIGTERM' }]);
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
