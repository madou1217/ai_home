const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexVscodeHookService,
  resolveCodexVscodeExtensionBinaryPaths
} = require('../lib/server/codex-vscode-hook');

function seedVscodeCodexBinary(root, version = '26.513.21555') {
  const targetBinaryPath = path.join(
    root,
    '.vscode',
    'extensions',
    `openai.chatgpt-${version}-darwin-arm64`,
    'bin',
    'macos-aarch64',
    'codex'
  );
  fs.mkdirSync(path.dirname(targetBinaryPath), { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho vscode-original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  return targetBinaryPath;
}

test('buildWrapperScript renders stable codex vscode wrapper', () => {
  const script = buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/helper.js',
    upstreamBinaryPath: '/tmp/codex.aih-original',
    stateFilePath: '/tmp/codex-desktop-hook-state.json'
  });

  assert.equal(script.includes(WRAPPER_MARKER), true);
  assert.equal(script.includes('/tmp/helper.js'), true);
  assert.equal(script.includes('/tmp/codex-desktop-hook-state.json'), true);
  assert.equal(script.includes('app-server'), true);
});

test('resolveCodexVscodeExtensionBinaryPaths finds OpenAI ChatGPT extension codex binaries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-vscode-hook-'));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_error) {}
  });
  const targetBinaryPath = seedVscodeCodexBinary(root);
  const ignoredPath = path.join(root, '.vscode', 'extensions', 'other.extension', 'bin', 'macos-aarch64', 'codex');
  fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
  fs.writeFileSync(ignoredPath, '#!/bin/sh\necho ignored\n', 'utf8');
  fs.chmodSync(ignoredPath, 0o755);

  const paths = resolveCodexVscodeExtensionBinaryPaths(fs, {
    path,
    hostHomeDir: root,
    processObj: { platform: 'darwin', env: {} }
  });

  assert.deepEqual(paths, [targetBinaryPath]);
});

test('codex vscode hook installs wrapper using shared desktop hook state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-vscode-hook-'));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_error) {}
  });
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const targetBinaryPath = seedVscodeCodexBinary(root);
  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ enabled: true }, null, 2), 'utf8');

  const service = createCodexVscodeHookService({
    fs,
    path,
    processObj: { pid: 601, platform: 'darwin', env: {}, kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  const result = service.activate();
  const wrapper = fs.readFileSync(targetBinaryPath, 'utf8');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.installed, 1);
  assert.equal(fs.existsSync(upstreamBinaryPath), true);
  assert.equal(fs.readFileSync(upstreamBinaryPath, 'utf8'), '#!/bin/sh\necho vscode-original\n');
  assert.equal(wrapper.includes(WRAPPER_MARKER), true);
  assert.equal(wrapper.includes('/tmp/codex-proxy.js'), true);
  assert.equal(wrapper.includes(statePath), true);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).enabled, true);
});

test('codex vscode hook self-heals overwritten extension binary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-vscode-hook-'));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_error) {}
  });
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const targetBinaryPath = seedVscodeCodexBinary(root);
  fs.writeFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), JSON.stringify({ enabled: true }, null, 2), 'utf8');

  const service = createCodexVscodeHookService({
    fs,
    path,
    processObj: { pid: 602, platform: 'darwin', env: {}, kill() {} },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  service.activate();
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho vscode-updated\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const result = service.ensureInstalled();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(`${targetBinaryPath}.aih-original`, 'utf8'), '#!/bin/sh\necho vscode-updated\n');
});

test('codex vscode hook can list and restart running extension app-servers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-vscode-hook-'));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_error) {}
  });
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const targetBinaryPath = seedVscodeCodexBinary(root);
  fs.writeFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), JSON.stringify({ enabled: true }, null, 2), 'utf8');
  const killed = [];

  const service = createCodexVscodeHookService({
    fs,
    path,
    processObj: {
      pid: 603,
      platform: 'darwin',
      env: {},
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
          ` 701 ${targetBinaryPath} app-server --analytics-default-enabled`,
          ` 702 ${targetBinaryPath}.aih-original app-server --listen stdio://`,
          ' 703 /tmp/other-codex app-server'
        ].join('\n')
      };
    },
    aiHomeDir,
    hostHomeDir: root,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js'
  });

  service.activate();
  const processes = service.listRunningAppServerProcesses();
  const restart = service.restartRunningAppServers();

  assert.deepEqual(processes.map((item) => item.pid), [701, 702]);
  assert.equal(restart.count, 2);
  assert.deepEqual(killed, [
    { pid: 701, signal: 'SIGTERM' },
    { pid: 702, signal: 'SIGTERM' }
  ]);
});
