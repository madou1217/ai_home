'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const {
  DEFAULT_TERMINAL_ID,
  executeClientTerminalAction,
  listClientTerminals,
  resolveClientTerminalLaunch,
  resolveTerminalActionPlan
} = require('../lib/runtime/client-terminal');

function fakeFs(paths = []) {
  const existing = new Set(paths);
  return { existsSync: (value) => existing.has(String(value)) };
}

test('终端目录按公共平台接口返回系统默认与平台可用终端', () => {
  const terminals = listClientTerminals({
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\wt.exe', 'C:\\tools\\wezterm.exe', 'C:\\tools\\winget.exe'])
  });
  assert.deepEqual(terminals.map((item) => item.id), [DEFAULT_TERMINAL_ID, 'wezterm', 'windows-terminal']);
  assert.equal(terminals.find((item) => item.id === 'windows-terminal').installed, true);
  assert.equal(terminals.find((item) => item.id === 'wezterm').canUpdate, true);
  assert.equal(terminals.find((item) => item.id === 'wezterm').packageManager, 'winget');
  assert.equal(terminals.find((item) => item.id === 'system-default').canUninstall, false);
});

test('终端启动选择隐藏平台实现并生成 Windows Terminal 参数', () => {
  const launch = resolveClientTerminalLaunch('windows-terminal', 'node app.js', 'aih codex 1', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\wt.exe'])
  });
  assert.equal(launch.terminalId, 'windows-terminal');
  assert.equal(launch.file, 'C:\\tools\\wt.exe');
  assert.deepEqual(launch.args, ['new-tab', '--title', 'aih codex 1', 'cmd.exe', '/k', 'node app.js']);
});

test('iTerm2 启动通过统一接口使用已检测到的 macOS 应用', () => {
  const launch = resolveClientTerminalLaunch('iterm2', 'node app.js', 'aih codex 1', {
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '' },
    fs: fakeFs(['/Users/test/Applications/iTerm.app'])
  });
  assert.equal(launch.terminalId, 'iterm2');
  assert.equal(launch.file, 'osascript');
  assert.match(launch.args.join(' '), /tell application "iTerm2"/);
});

test('终端安装计划使用官方稳定包管理器命令', () => {
  const macPlan = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'install' }, {
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew'])
  });
  assert.equal(macPlan.ok, true);
  assert.deepEqual(macPlan.args, ['install', '--cask', 'wezterm']);

  const linuxPlan = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'install' }, {
    platform: 'linux',
    path: nodePath.posix,
    env: { PATH: '/usr/bin' },
    fs: fakeFs(['/usr/bin/flatpak'])
  });
  assert.equal(linuxPlan.ok, true);
  assert.deepEqual(linuxPlan.args, ['install', '--user', '-y', 'flathub', 'org.wezfurlong.wezterm']);
});

test('终端执行必须显式确认并通过抽象计划运行', async () => {
  const calls = [];
  const denied = await executeClientTerminalAction({ terminalId: 'wezterm', action: 'install' }, {
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew'])
  });
  assert.equal(denied.error, 'confirmation_required');

  const result = await executeClientTerminalAction({ terminalId: 'wezterm', action: 'install', confirmed: true }, {
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew']),
    runPlan: async (plan) => {
      calls.push(plan);
      return { ok: true };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].file, '/opt/homebrew/bin/brew');
});
