'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const {
  listClientTerminals,
  resolveTerminalActionPlan
} = require('../lib/runtime/client-terminal');

const SYSTEM_TERMINALS = new Set(['system-default', 'cmd']);

function fakeFs(paths) {
  const existing = new Set(paths);
  return { existsSync: (value) => existing.has(String(value)) };
}

const PLATFORM_CASES = Object.freeze([
  Object.freeze({
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '/opt/homebrew/bin' },
    paths: [
      '/opt/homebrew/bin/brew',
      '/Applications/WezTerm.app/Contents/MacOS/wezterm',
      '/Applications/Warp.app/Contents/MacOS/stable',
      '/Applications/iTerm.app'
    ]
  }),
  Object.freeze({
    platform: 'windows',
    path: nodePath.win32,
    env: { USERPROFILE: 'C:\\Users\\test', PATH: 'C:\\tools' },
    paths: [
      'C:\\tools\\winget.exe',
      'C:\\tools\\wt.exe',
      'C:\\tools\\wezterm.exe',
      'C:\\tools\\warp.exe'
    ]
  }),
  Object.freeze({
    platform: 'linux',
    path: nodePath.posix,
    env: { HOME: '/home/test', PATH: '/usr/bin' },
    paths: [
      '/usr/bin/flatpak',
      '/usr/bin/apt-get',
      '/usr/bin/wezterm',
      '/usr/bin/warp-terminal'
    ]
  })
]);

test('三平台所有非系统内建终端均提供完整生命周期计划', () => {
  for (const platformCase of PLATFORM_CASES) {
    const terminals = listClientTerminals({
      platform: platformCase.platform,
      path: platformCase.path,
      env: platformCase.env,
      fs: fakeFs(platformCase.paths)
    }).filter((terminal) => !SYSTEM_TERMINALS.has(terminal.id));

    assert.ok(terminals.length > 0, `${platformCase.platform} 应返回可管理终端`);
    for (const terminal of terminals) {
      assert.equal(terminal.installed, true, `${platformCase.platform}/${terminal.id} 应被探测为已安装`);
      assert.equal(terminal.canUpdate, true, `${platformCase.platform}/${terminal.id} 缺少更新计划`);
      assert.equal(terminal.canUninstall, true, `${platformCase.platform}/${terminal.id} 缺少卸载计划`);
      assert.deepEqual(
        terminal.plans.map((plan) => plan.action),
        ['install', 'update', 'uninstall'],
        `${platformCase.platform}/${terminal.id} 生命周期计划不完整`
      );
    }
  }
});

const INSTALLED_WITHOUT_PACKAGE_MANAGER_CASES = Object.freeze([
  Object.freeze({
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '' },
    paths: [
      '/Applications/WezTerm.app/Contents/MacOS/wezterm',
      '/Applications/Warp.app/Contents/MacOS/stable',
      '/Applications/iTerm.app'
    ]
  }),
  Object.freeze({
    platform: 'windows',
    path: nodePath.win32,
    env: { USERPROFILE: 'C:\\Users\\test', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PATH: 'C:\\tools' },
    paths: [
      'C:\\tools\\wt.exe',
      'C:\\tools\\wezterm.exe',
      'C:\\tools\\warp.exe'
    ]
  }),
  Object.freeze({
    platform: 'linux',
    path: nodePath.posix,
    env: { HOME: '/home/test', PATH: '/usr/bin' },
    paths: [
      '/usr/bin/wezterm',
      '/usr/bin/warp-terminal'
    ]
  })
]);

test('已安装终端在包管理器不存在时回退到官方更新和卸载计划', () => {
  for (const platformCase of INSTALLED_WITHOUT_PACKAGE_MANAGER_CASES) {
    const terminals = listClientTerminals({
      platform: platformCase.platform,
      path: platformCase.path,
      env: platformCase.env,
      fs: fakeFs(platformCase.paths)
    }).filter((terminal) => !SYSTEM_TERMINALS.has(terminal.id));

    assert.ok(terminals.length > 0, `${platformCase.platform} 应返回可管理终端`);
    for (const terminal of terminals) {
      assert.equal(terminal.installed, true, `${platformCase.platform}/${terminal.id} 应被探测为已安装`);
      assert.equal(terminal.canUpdate, true, `${platformCase.platform}/${terminal.id} 缺少官方更新兜底`);
      assert.equal(terminal.canUninstall, true, `${platformCase.platform}/${terminal.id} 缺少官方卸载兜底`);
      assert.equal(terminal.packageManager, 'official', `${platformCase.platform}/${terminal.id} 应标记官方直装兜底`);
      assert.deepEqual(
        terminal.plans.map((plan) => plan.action),
        ['install', 'update', 'uninstall'],
        `${platformCase.platform}/${terminal.id} 官方生命周期计划不完整`
      );
    }
  }
});

test('Windows 注册表卸载完成后仍清理 AIH 受管的 WezTerm 目录', () => {
  const plan = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'uninstall' }, {
    platform: 'windows',
    path: nodePath.win32,
    env: {
      USERPROFILE: 'C:\\Users\\test',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      PATH: 'C:\\tools'
    },
    fs: fakeFs(['C:\\tools\\wezterm.exe'])
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.packageManager, 'official');
  const script = plan.args.at(-1);
  assert.match(script, /\$uninstalled = \$false/);
  assert.doesNotMatch(script, /exit 0/);
  assert.ok(script.indexOf('Start-Process') < script.indexOf('$targets = @'));
  assert.match(script, /if \(-not \$uninstalled -and -not \$removed\)/);
});

test('macOS 官方卸载不会从任意 PATH 推导应用删除目标', () => {
  const maliciousExecutable = '/tmp/evil/WezTerm.app/Contents/MacOS/wezterm';
  const plan = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'uninstall' }, {
    platform: 'macos',
    path: nodePath.posix,
    hostHomeDir: '/Users/test',
    env: {
      HOME: '/Users/test',
      PATH: '/tmp/evil/WezTerm.app/Contents/MacOS'
    },
    fs: fakeFs([maliciousExecutable])
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.packageManager, 'official');
  const script = plan.args.at(-1);
  assert.doesNotMatch(script, /\/tmp\/evil\/WezTerm\.app/);
  assert.match(script, /\/Users\/test\/Applications\/WezTerm\.app/);
});

test('未安装终端且包管理器不存在时仍提供官方安装计划', () => {
  const platformCases = [
    { platform: 'macos', path: nodePath.posix, env: { HOME: '/Users/test', PATH: '' } },
    {
      platform: 'windows',
      path: nodePath.win32,
      env: { USERPROFILE: 'C:\\Users\\test', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PATH: '' }
    },
    { platform: 'linux', path: nodePath.posix, env: { HOME: '/home/test', PATH: '' } }
  ];

  for (const platformCase of platformCases) {
    const terminals = listClientTerminals({
      ...platformCase,
      fs: fakeFs([])
    }).filter((terminal) => !SYSTEM_TERMINALS.has(terminal.id));

    assert.ok(terminals.length > 0, `${platformCase.platform} 应返回可管理终端`);
    for (const terminal of terminals) {
      assert.equal(terminal.installed, false, `${platformCase.platform}/${terminal.id} 不应误报已安装`);
      assert.equal(terminal.canInstall, true, `${platformCase.platform}/${terminal.id} 缺少官方安装兜底`);
      assert.equal(terminal.canUpdate, false);
      assert.equal(terminal.canUninstall, false);
      assert.equal(terminal.packageManager, 'official', `${platformCase.platform}/${terminal.id} 应标记官方直装兜底`);
      assert.deepEqual(
        terminal.plans.map((plan) => plan.action),
        ['install', 'update', 'uninstall'],
        `${platformCase.platform}/${terminal.id} 官方生命周期计划不完整`
      );
    }
  }
});
