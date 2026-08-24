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

// fakeStoreAliasFs 模拟 Store 应用可执行别名（AppExecutionAlias）：0 字节
// reparse point，existsSync 返回 false，只有 accessSync/lstatSync 看得见。
function fakeStoreAliasFs(aliasPaths = []) {
  const aliases = new Set(aliasPaths);
  return {
    existsSync: () => false,
    accessSync: (value) => {
      if (aliases.has(String(value))) return;
      const error = new Error('EACCES');
      error.code = 'EACCES';
      throw error;
    }
  };
}

test('终端目录按公共平台接口返回系统默认与平台可用终端', () => {
  const terminals = listClientTerminals({
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\wt.exe', 'C:\\tools\\wezterm.exe', 'C:\\tools\\winget.exe'])
  });
  // Windows 无「系统默认」概念：默认 Windows Terminal、其次 CMD
  assert.deepEqual(terminals.map((item) => item.id), ['windows-terminal', 'cmd', 'wezterm', 'warp']);
  assert.equal(terminals.find((item) => item.id === 'windows-terminal').installed, true);
  assert.equal(terminals.find((item) => item.id === 'windows-terminal').default, true);
  assert.equal(terminals.find((item) => item.id === 'cmd').installed, true);
  assert.equal(terminals.find((item) => item.id === 'wezterm').canUpdate, true);
  assert.equal(terminals.find((item) => item.id === 'wezterm').packageManager, 'winget');
  assert.equal(terminals.find((item) => item.id === 'cmd').canUninstall, false);
});

test('未安装 Windows Terminal 时 CMD 成为 Windows 默认终端', () => {
  const terminals = listClientTerminals({
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs([])
  });
  // 未安装的终端仍列出（供 Toolkit 提供安装入口），只是 default 标记落到 CMD
  assert.deepEqual(terminals.map((item) => item.id), ['windows-terminal', 'cmd', 'wezterm', 'warp']);
  assert.equal(terminals.find((item) => item.id === 'windows-terminal').installed, false);
  assert.equal(terminals.find((item) => item.id === 'windows-terminal').default, false);
  assert.equal(terminals.find((item) => item.id === 'cmd').default, true);
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
  assert.deepEqual(launch.args, [
    '-w', 'new', 'new-tab', '--title', 'aih codex 1',
    'cmd.exe', '/d', '/s', '/k', 'node', 'app.js'
  ]);
});

test('Windows 系统默认终端以 verbatim 命令行把整段命令包进新窗口', () => {
  const command = 'set "AIH_ACCOUNT_APP=1" && set "AIH_PROVIDER_ACCOUNT_REF=ref-1" && '
    + '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\bin\\ai-home.js" codex 12';
  const launch = resolveClientTerminalLaunch(DEFAULT_TERMINAL_ID, command, 'aih codex 12', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' }
  });
  assert.equal(launch.terminalId, DEFAULT_TERMINAL_ID);
  assert.equal(launch.file, 'cmd.exe');
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  // 命令整段包进内层 cmd /d /s /k "…"，set A && set B && <cli> 链不会在外层被拆开
  assert.equal(
    launch.args[3],
    `start "aih codex 12" cmd.exe /d /s /k "${command}"`
  );
  // 回归守卫：cmd.exe 不认识 \" 转义，命令行里出现即会让 start 挂死
  assert.ok(!launch.args[3].includes('\\"'));
});

test('AppExecutionAlias 形态的 wt.exe 也能被探测到（existsSync 看不见别名）', () => {
  const terminals = listClientTerminals({
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeStoreAliasFs(['C:\\tools\\wt.exe'])
  });
  const wt = terminals.find((item) => item.id === 'windows-terminal');
  assert.equal(wt.installed, true);
  assert.equal(wt.executablePath, 'C:\\tools\\wt.exe');
});

test('Windows 系统默认终端探测到 wt.exe 时直接委托 Windows Terminal', () => {
  const command = 'set "AIH_ACCOUNT_APP=1" && node app.js';
  const launch = resolveClientTerminalLaunch(DEFAULT_TERMINAL_ID, command, 'aih codex 12', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeStoreAliasFs(['C:\\tools\\wt.exe'])
  });
  // OS 默认终端 deflection 从隐藏父进程启动时不生效，system-default 须显式走 wt；
  // -w new 强制弹独立窗口（new-tab 会复用既有窗口，目标窗口在别的桌面时
  // 用户表现为「点了没反应」）；windowsHide 必须为 false，否则 CREATE_NO_WINDOW
  // 会把 WT 新窗口创建成隐藏窗口（进程链正常但用户看不到）。
  assert.equal(launch.terminalId, 'windows-terminal');
  assert.equal(launch.file, 'C:\\tools\\wt.exe');
  assert.deepEqual(
    launch.args,
    [
      '-w', 'new', 'new-tab', '--title', 'aih codex 12',
      'cmd.exe', '/d', '/s', '/k',
      'set', 'AIH_ACCOUNT_APP=1', '&&', 'node', 'app.js'
    ]
  );
  assert.equal(launch.windowsHide, false);
});

test('Windows Terminal 不把带 set 标记的整段命令误组装成 cmd.exe /k set', () => {
  const command = 'set "AIH_ACCOUNT_APP=1" && set "AIH_PROVIDER_ACCOUNT_REF=acct_d62c5c4961277f9403c8" && '
    + '"d:\\nvm4w\\nodejs\\node.exe" "C:\\Users\\madou\\projects\\feature\\ai_home\\bin\\ai-home.js" codex 3';
  const launch = resolveClientTerminalLaunch('windows-terminal', command, 'aih codex 3', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\wt.exe'])
  });
  assert.deepEqual(launch.args.slice(0, 9), [
    '-w', 'new', 'new-tab', '--title', 'aih codex 3',
    'cmd.exe', '/d', '/s', '/k'
  ]);
  assert.deepEqual(launch.args.slice(9), [
    'set', 'AIH_ACCOUNT_APP=1', '&&',
    'set', 'AIH_PROVIDER_ACCOUNT_REF=acct_d62c5c4961277f9403c8', '&&',
    'd:\\nvm4w\\nodejs\\node.exe',
    'C:\\Users\\madou\\projects\\feature\\ai_home\\bin\\ai-home.js',
    'codex', '3'
  ]);
  const windowsTerminalCommandline = launch.args.slice(5)
    .map((arg) => /\s/.test(arg) ? `"${arg}"` : arg)
    .join(' ');
  assert.equal(
    windowsTerminalCommandline,
    'cmd.exe /d /s /k set AIH_ACCOUNT_APP=1 && '
      + 'set AIH_PROVIDER_ACCOUNT_REF=acct_d62c5c4961277f9403c8 && '
      + 'd:\\nvm4w\\nodejs\\node.exe '
      + 'C:\\Users\\madou\\projects\\feature\\ai_home\\bin\\ai-home.js codex 3'
  );
  assert.match(windowsTerminalCommandline, /^cmd\.exe \/d \/s \/k set /);
  assert.doesNotMatch(windowsTerminalCommandline, /^"cmd\.exe \/k set"/);
  assert.ok(!launch.args.some((arg) => arg.includes('cmd.exe /k set')));
  assert.ok(!launch.args.some((arg) => arg.includes('AIH_ACCOUNT_APP=1"')));
});

test('Windows Terminal 保留带空格的可执行路径为单个 positional arg', () => {
  const command = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\AI Home\\bin\\ai-home.js" codex 3';
  const launch = resolveClientTerminalLaunch('windows-terminal', command, 'aih codex 3', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeFs(['C:\\tools\\wt.exe'])
  });
  assert.deepEqual(launch.args.slice(9), [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\AI Home\\bin\\ai-home.js',
    'codex', '3'
  ]);
});

test('CMD 终端适配器用 cmd start 打开 conhost 窗口', () => {
  const command = 'set "AIH_ACCOUNT_APP=1" && node app.js';
  const launch = resolveClientTerminalLaunch('cmd', command, 'aih codex 12', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' }
  });
  assert.equal(launch.terminalId, 'cmd');
  assert.equal(launch.file, 'cmd.exe');
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.equal(
    launch.args[3],
    `start "aih codex 12" cmd.exe /d /s /k "${command}"`
  );
});

test('WebUI 唤起 Windows 系统默认终端时向 spawn 传递 verbatim 标记', () => {
  const calls = [];
  const result = launchClientTerminal(DEFAULT_TERMINAL_ID, {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 11, unref() {} };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].file, 'cmd.exe');
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
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

test('Warp 使用 Windows 官方 winget 标识，Linux 提供官方系统包生命周期', () => {
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
    env: { HOME: '/home/test', PATH: '' },
    fs: fakeFs(['/usr/bin/warp-terminal', '/usr/bin/apt-get'])
  };
  const warp = listClientTerminals(linuxOptions).find((item) => item.id === 'warp');
  assert.equal(warp.installed, true);
  assert.equal(warp.canLaunch, true);
  assert.equal(warp.canUpdate, true);
  assert.equal(warp.canUninstall, true);
  assert.equal(warp.packageManager, 'apt');
  assert.deepEqual(warp.plans.map((plan) => plan.action), ['install', 'update', 'uninstall']);

  const launch = resolveClientTerminalLaunch('warp', 'node app.js', 'AI Home Warp', linuxOptions);
  assert.equal(launch.file, '/usr/bin/warp-terminal');
  assert.deepEqual(launch.args, []);

  const updatePlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'update' }, linuxOptions);
  assert.equal(updatePlan.ok, true);
  assert.equal(updatePlan.file, '/bin/sh');
  assert.equal(updatePlan.packageManager, 'apt');
  assert.match(updatePlan.args[1], /apt-get update/);
  assert.match(updatePlan.args[1], /apt-get install -y --only-upgrade warp-terminal/);

  const uninstallPlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'uninstall' }, linuxOptions);
  assert.equal(uninstallPlan.ok, true);
  assert.match(uninstallPlan.args[1], /apt-get remove -y warp-terminal/);

  const installPlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'install' }, {
    ...linuxOptions,
    fs: fakeFs(['/usr/bin/apt-get'])
  });
  assert.equal(installPlan.ok, true);
  assert.match(installPlan.args[1], /https:\/\/releases\.warp\.dev\/linux\/keys\/warp\.asc/);
  assert.match(installPlan.args[1], /https:\/\/releases\.warp\.dev\/linux\/deb stable main/);
  assert.match(installPlan.args[1], /apt-get install -y warp-terminal/);
});

test('Warp Linux 按 dnf 与 yum 生成各自的更新和卸载计划', () => {
  for (const packageManager of ['dnf', 'yum']) {
    const options = {
      platform: 'linux',
      path: nodePath.posix,
      env: { HOME: '/home/test', PATH: '/usr/bin' },
      fs: fakeFs(['/usr/bin/warp-terminal', `/usr/bin/${packageManager}`])
    };
    const updatePlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'update' }, options);
    const uninstallPlan = resolveTerminalActionPlan({ terminalId: 'warp', action: 'uninstall' }, options);

    assert.equal(updatePlan.ok, true);
    assert.equal(updatePlan.packageManager, packageManager);
    assert.match(updatePlan.args[1], new RegExp(`${packageManager} (?:upgrade|update) -y warp-terminal`));
    assert.equal(uninstallPlan.ok, true);
    assert.match(uninstallPlan.args[1], new RegExp(`${packageManager} remove -y warp-terminal`));
  }
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

test('Windows GUI 进程 PATH 不完整时从用户应用目录发现 winget', () => {
  const plan = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'install' }, {
    platform: 'windows',
    path: nodePath.win32,
    env: { USERPROFILE: 'C:\\Users\\test', PATH: '' },
    fs: fakeFs(['C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe'])
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.file, 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe');
  assert.equal(plan.packageManager, 'winget');
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

test('macOS 无 Homebrew 时使用各终端官方发布源直装', () => {
  const options = {
    platform: 'macos',
    path: nodePath.posix,
    env: { HOME: '/Users/test', PATH: '' },
    processObj: { platform: 'darwin', arch: 'arm64', env: {} },
    fs: fakeFs([])
  };
  const wezterm = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'install' }, options);
  const warp = resolveTerminalActionPlan({ terminalId: 'warp', action: 'install' }, options);
  const iterm = resolveTerminalActionPlan({ terminalId: 'iterm2', action: 'install' }, options);

  assert.equal(wezterm.ok, true);
  assert.equal(wezterm.packageManager, 'official');
  assert.match(wezterm.args[1], /api\.github\.com\/repos\/wezterm\/wezterm\/releases\/latest/);
  assert.match(wezterm.args[1], /WezTerm-macos-/);
  assert.match(wezterm.args[1], /Applications\/WezTerm\.app/);

  assert.equal(warp.ok, true);
  assert.equal(warp.packageManager, 'official');
  assert.match(warp.args[1], /app\.warp\.dev\/download\?package=dmg_arm64/);
  assert.match(warp.args[1], /Applications\/Warp\.app/);

  assert.equal(iterm.ok, true);
  assert.equal(iterm.packageManager, 'official');
  assert.match(iterm.args[1], /iterm2\.com\/downloads\.html/);
  assert.match(iterm.args[1], /Applications\/iTerm\.app/);
});

test('Windows 无 winget 时使用官方发布源和系统安装 API', () => {
  const options = {
    platform: 'windows',
    path: nodePath.win32,
    env: {
      USERPROFILE: 'C:\\Users\\test',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
      PATH: ''
    },
    processObj: { platform: 'win32', arch: 'x64', env: { SystemRoot: 'C:\\Windows' } },
    fs: fakeFs([])
  };
  const wezterm = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'install' }, options);
  const warp = resolveTerminalActionPlan({ terminalId: 'warp', action: 'install' }, options);
  const windowsTerminal = resolveTerminalActionPlan({ terminalId: 'windows-terminal', action: 'install' }, options);

  assert.equal(wezterm.ok, true);
  assert.equal(wezterm.packageManager, 'official');
  assert.match(wezterm.args.at(-1), /api\.github\.com\/repos\/wezterm\/wezterm\/releases\/latest/);
  assert.match(wezterm.args.at(-1), /Expand-Archive/);
  assert.match(wezterm.args.at(-1), /Programs\\WezTerm/);

  assert.equal(warp.ok, true);
  assert.equal(warp.packageManager, 'official');
  assert.match(warp.args.at(-1), /app\.warp\.dev\/download\?package=windows/);
  assert.match(warp.args.at(-1), /VERYSILENT/);

  assert.equal(windowsTerminal.ok, true);
  assert.equal(windowsTerminal.packageManager, 'official');
  assert.match(windowsTerminal.args.at(-1), /api\.github\.com\/repos\/microsoft\/terminal\/releases\/latest/);
  assert.match(windowsTerminal.args.at(-1), /Add-AppxPackage/);
});

test('Linux 无包管理器时使用官方 AppImage 并保留可执行卸载计划', () => {
  const uninstalledOptions = {
    platform: 'linux',
    path: nodePath.posix,
    env: { HOME: '/home/test', PATH: '' },
    processObj: { platform: 'linux', arch: 'x64', env: {} },
    fs: fakeFs([])
  };
  const wezterm = resolveTerminalActionPlan({ terminalId: 'wezterm', action: 'install' }, uninstalledOptions);
  const warp = resolveTerminalActionPlan({ terminalId: 'warp', action: 'install' }, uninstalledOptions);

  assert.equal(wezterm.ok, true);
  assert.equal(wezterm.packageManager, 'official');
  assert.match(wezterm.args[1], /api\.github\.com\/repos\/wezterm\/wezterm\/releases\/latest/);
  assert.match(wezterm.args[1], /Ubuntu20\.04\.AppImage/);
  assert.match(wezterm.args[1], /\.local\/bin\/wezterm/);

  assert.equal(warp.ok, true);
  assert.equal(warp.packageManager, 'official');
  assert.match(warp.args[1], /app\.warp\.dev\/download\?package=appimage/);
  assert.match(warp.args[1], /\.local\/bin\/warp-terminal/);

  const uninstall = resolveTerminalActionPlan({ terminalId: 'warp', action: 'uninstall' }, {
    ...uninstalledOptions,
    env: { HOME: '/home/test', PATH: '/usr/bin' },
    fs: fakeFs(['/usr/bin/warp-terminal'])
  });
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.packageManager, 'official');
  assert.match(uninstall.args[1], /\/usr\/bin\/warp-terminal/);
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

test('launchClientTerminal 按规格透传 windowsHide（wt 显窗、其余缺省隐藏）', () => {
  const calls = [];
  const spySpawn = (file, args, options) => {
    calls.push({ file, options });
    return { pid: 9, unref() {} };
  };
  const wt = launchClientTerminal('windows-terminal', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    fs: fakeStoreAliasFs(['C:\\tools\\wt.exe']),
    spawn: spySpawn
  });
  assert.equal(wt.ok, true);
  assert.equal(calls[0].options.windowsHide, false);
  const cmd = launchClientTerminal('cmd', {
    platform: 'windows',
    path: nodePath.win32,
    env: { PATH: 'C:\\tools' },
    spawn: spySpawn
  });
  assert.equal(cmd.ok, true);
  assert.equal(calls[1].options.windowsHide, true);
});
