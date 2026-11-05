'use strict';

// 回归：持久会话启动后，pty 必须带着「这次进的是哪个会话、是不是自己新建的」。
// 换号退休旧会话全靠这份信息；丢了它，换一次号就多一个空闲 provider 进程
// （2026-11-05 用户报的垃圾进程）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPersistentLaunchWrapper } = require('../lib/cli/services/pty/persistent-launch');

const FAKE_TMUX = '/fake/bin/tmux';

function createHarness() {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-persist-info-'));
  const spawnCalls = [];
  const wrapper = createPersistentLaunchWrapper({
    fs: {
      ...fs,
      // 只伪造 tmux 探测；registry / conf 仍然写真实临时目录。
      existsSync: (target) => (target === FAKE_TMUX ? true : fs.existsSync(target))
    },
    path,
    processObj: {
      platform: 'darwin',
      pid: 4242,
      cwd: () => aiHomeDir,
      env: {},
      stdout: { isTTY: true }
    },
    spawnSync: (command, args) => {
      spawnCalls.push([command, ...(Array.isArray(args) ? args : [])]);
      return { status: 0, stdout: '', stderr: '' };
    },
    aiHomeDir,
    hostHomeDir: aiHomeDir,
    resolveCliPath: (name) => (name === 'tmux' ? FAKE_TMUX : ''),
    askYesNo: () => false
  });
  return { aiHomeDir, spawnCalls, wrapper };
}

function launchContext(overrides = {}) {
  return {
    cliName: 'codebuddy',
    cliBin: 'codebuddy',
    argsToRun: ['--permission-mode', 'bypassPermissions'],
    accountRef: 'acct_0123456789abcdef0123',
    gateway: false,
    runtimeScope: 'acct_0123456789abcdef0123',
    runtimeDir: '/tmp/projection',
    // 走普通持久化（不套 provider supervisor），这里只验证会话元信息。
    usesAuthProjection: false,
    cliAccountId: '3',
    isLogin: false,
    envOverrides: {},
    ...overrides
  };
}

test('新建会话：pty 元信息标记 owned，换号时才知道该退休谁', () => {
  const { wrapper } = createHarness();
  const launch = { command: 'codebuddy', args: ['--permission-mode', 'bypassPermissions'] };
  const wrapped = wrapper.maybeWrapPersistentLaunch(launch, launchContext());
  assert.ok(wrapped && wrapped.persistentSessionInfo, '持久会话必须带 persistentSessionInfo');
  assert.equal(wrapped.persistentSessionInfo.owned, true);
  assert.equal(wrapped.persistentSessionInfo.command, FAKE_TMUX);
  assert.equal(wrapped.persistentSessionInfo.socket, wrapped.socket);
  assert.equal(wrapped.persistentSessionInfo.session, wrapped.session);
});

test('非持久化（无 tmux）：不写元信息，普通 PTY 行为不变', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-persist-off-'));
  const wrapper = createPersistentLaunchWrapper({
    fs,
    path,
    processObj: {
      platform: 'darwin',
      pid: 4242,
      cwd: () => aiHomeDir,
      env: { AIH_NO_PERSIST: '1' },
      stdout: { isTTY: true }
    },
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    aiHomeDir,
    hostHomeDir: aiHomeDir,
    resolveCliPath: (name) => (name === 'tmux' ? FAKE_TMUX : ''),
    askYesNo: () => false
  });
  const launch = { command: 'codebuddy', args: [] };
  const wrapped = wrapper.maybeWrapPersistentLaunch(launch, launchContext());
  assert.equal(wrapped, launch);
  assert.equal(wrapped.persistentSessionInfo, undefined);
});
