'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const {
  DEFAULT_TERMINAL_ID,
  launchClientTerminal,
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
  assert.deepEqual(terminals.map((item) => item.id), [DEFAULT_TERMINAL_ID, 'wezterm', 'warp', 'windows-terminal']);
  assert.equal(terminals.find((item) => item.id === 'windows-terminal').installed, true);
  assert.equal(terminals.find((item) => item.id === 'wezterm').canUpdate, true);
  assert.equal(terminals.find((item) => item.id === 'wezterm').packageManager, 'winget');
  assert.equal(terminals.find((item) => item.id === 'system-default').canUninstall, false);
});

test('每个终端适配器实现统一 install/update/uninstall 生命周期接口', () => {
  const terminals = listClientTerminals({
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew'])
  });
  assert.ok(terminals.length > 0);
  const definitions = require('../lib/runtime/client-terminal').TERMINAL_DEFINITIONS;
  Object.values(definitions).forEach((adapter) => {
    assert.equal(typeof adapter.install, 'function');
    assert.equal(typeof adapter.update, 'function');
    assert.equal(typeof adapter.uninstall, 'function');
  });
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

test('WebUI 唤起已安装终端时复用平台适配器并立即脱离请求进程', () => {
  const calls = [];
  const result = launchClientTerminal('wezterm', {
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '/opt/homebrew/bin', SHELL: '/bin/zsh' },
    fs: fakeFs(['/opt/homebrew/bin/wezterm']),
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 42, unref() { calls.push({ unref: true }); } };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminalId, 'wezterm');
  assert.equal(result.pid, 42);
  assert.equal(calls[0].file, '/opt/homebrew/bin/wezterm');
  assert.deepEqual(calls[0].args.slice(0, 3), ['start', '--always-new-process', '--']);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls.at(-1), { unref: true });
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

test('Warp 在 macOS 使用官方应用并生成 Homebrew 生命周期计划', () => {
  const options = {
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '/opt/homebrew/bin' },
    fs: fakeFs([
      '/Applications/Warp.app/Contents/MacOS/stable',
      '/opt/homebrew/bin/brew'
    ])
  };
  const warp = listClientTerminals(options).find((item) => item.id === 'warp');
  assert.equal(warp.installed, true);
  assert.equal(warp.canLaunch, true);
  assert.equal(warp.canUpdate, true);
  assert.equal(warp.packageManager, 'homebrew');
  assert.equal(warp.sourceUrl, 'https://www.warp.dev/terminal');

  const launch = resolveClientTerminalLaunch('warp', 'node app.js', 'AI Home Warp', options);
  assert.equal(launch.file, '/usr/bin/open');
  assert.deepEqual(launch.args, ['-n', '-a', 'Warp']);

  const updatePlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'update' }, options);
  assert.equal(updatePlan.ok, true);
  assert.deepEqual(updatePlan.args, ['upgrade', '--cask', 'warp']);
});

test('Warp 使用 Windows 官方 winget 标识，Linux 仅检测和唤起现有安装', () => {
  const windowsPlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'install' }, {
    platform: 'windows',
    path: nodePath.win32,
    env: { LOCALAPPDATA: 'D:\\Profiles\\test\\Local', PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\winget.exe'])
  });
  assert.equal(windowsPlan.ok, true);
  assert.deepEqual(windowsPlan.args, ['install', '--id', 'Warp.Warp', '--exact', '--source', 'winget']);

  const windowsInstalledOptions = {
    platform: 'windows',
    path: nodePath.win32,
    env: { LOCALAPPDATA: 'D:\\Profiles\\test\\Local', PATH: 'C:\\tools' },
    fs: fakeFs(['D:\\Profiles\\test\\Local\\Programs\\Warp\\Warp.exe'])
  };
  const windowsWarp = listClientTerminals(windowsInstalledOptions).find((item) => item.id === 'warp');
  assert.equal(windowsWarp.installed, true);
  assert.equal(windowsWarp.executablePath, 'D:\\Profiles\\test\\Local\\Programs\\Warp\\Warp.exe');
  const windowsLaunch = resolveClientTerminalLaunch('warp', 'node app.js', 'AI Home Warp', windowsInstalledOptions);
  assert.equal(windowsLaunch.file, 'D:\\Profiles\\test\\Local\\Programs\\Warp\\Warp.exe');
  assert.deepEqual(windowsLaunch.args, []);

  const linuxOptions = {
    platform: 'linux',
    path: nodePath.posix,
    env: { HOME: '/home/test', PATH: '/usr/bin' },
    fs: fakeFs(['/usr/bin/warp-terminal', '/usr/bin/flatpak'])
  };
  const warp = listClientTerminals(linuxOptions).find((item) => item.id === 'warp');
  assert.equal(warp.installed, true);
  assert.equal(warp.canLaunch, true);
  assert.equal(warp.canUpdate, false);
  assert.equal(warp.canUninstall, false);
  assert.deepEqual(warp.plans, []);

  const launch = resolveClientTerminalLaunch('warp', 'node app.js', 'AI Home Warp', linuxOptions);
  assert.equal(launch.file, '/usr/bin/warp-terminal');
  assert.deepEqual(launch.args, []);
});

test('GUI 进程 PATH 不完整时，已安装终端仍能生成官方更新和卸载计划', () => {
  const terminals = listClientTerminals({
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '' },
    fs: fakeFs(['/Users/test/Applications/iTerm.app', '/opt/homebrew/bin/brew'])
  });
  const iterm = terminals.find((item) => item.id === 'iterm2');
  assert.equal(iterm.installed, true);
  assert.equal(iterm.canUpdate, true);
  assert.equal(iterm.canUninstall, true);
  assert.equal(iterm.packageManager, 'homebrew');
  assert.deepEqual(iterm.plans.map((plan) => plan.action), ['install', 'update', 'uninstall']);
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
