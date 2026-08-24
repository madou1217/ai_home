'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listManagedTools,
  planManagedToolAction,
  readManagedToolConfig,
  saveManagedToolConfig
} = require('../lib/cli/services/toolkit/tool-manager');
const persistentSession = require('../lib/runtime/persistent-session');

let adapterApi = {};
try {
  adapterApi = require('../lib/cli/services/toolkit/managed-tools');
} catch (_error) {}

let herdrUninstallRunner = {};
try {
  herdrUninstallRunner = require('../lib/cli/services/toolkit/managed-tools/herdr-uninstall-runner');
} catch (_error) {}

function commandResolver(entries = {}) {
  return (command) => String(entries[command] || '');
}

function successfulVersionProbe(command, args) {
  const name = path.basename(String(command || '')).toLowerCase();
  if (name === 'brew') return { status: 0, stdout: '', stderr: '' };
  if (name.includes('tmux')) return { status: 0, stdout: 'tmux 3.5a\n', stderr: '' };
  if (name.includes('psmux')) return { status: 0, stdout: 'psmux 3.3.7\n', stderr: '' };
  if (name.includes('herdr')) return { status: 0, stdout: 'herdr 0.8.2\n', stderr: '' };
  if (name.includes('frpc')) return { status: 0, stdout: 'frpc 0.71.0\n', stderr: '' };
  if (args && args[0] === 'list') return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
}

function macOptions(overrides = {}) {
  const home = overrides.home || '/Users/tester';
  return {
    platform: 'macos',
    aiHomeDir: path.posix.join(home, '.ai_home'),
    hostHomeDir: home,
    processObj: {
      platform: 'darwin',
      arch: 'arm64',
      execPath: process.execPath,
      env: { HOME: home, PATH: '' }
    },
    processEntries: [],
    startupEntries: [],
    resolveCommandPath: commandResolver(overrides.commands || {}),
    spawnSync: overrides.spawnSync || successfulVersionProbe,
    ...overrides
  };
}

function linuxOptions(overrides = {}) {
  const home = overrides.home || '/home/tester';
  return {
    platform: 'linux',
    aiHomeDir: path.posix.join(home, '.ai_home'),
    hostHomeDir: home,
    processObj: {
      platform: 'linux',
      arch: 'x64',
      execPath: process.execPath,
      env: { HOME: home, PATH: '' }
    },
    processEntries: [],
    startupEntries: [],
    resolveCommandPath: commandResolver(overrides.commands || {}),
    spawnSync: overrides.spawnSync || successfulVersionProbe,
    ...overrides
  };
}

function windowsOptions(overrides = {}) {
  const home = overrides.home || 'C:\\Users\\tester';
  const localAppData = overrides.localAppData || 'C:\\Users\\tester\\AppData\\Local';
  return {
    platform: 'windows',
    aiHomeDir: `${home}\\.ai_home`,
    hostHomeDir: home,
    processObj: {
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: { USERPROFILE: home, LOCALAPPDATA: localAppData, PATH: '' }
    },
    processEntries: [],
    startupEntries: [],
    resolveCommandPath: commandResolver(overrides.commands || {}),
    spawnSync: overrides.spawnSync || successfulVersionProbe,
    ...overrides
  };
}

test('每个会话运行时和网络工具由独立适配器实现统一生命周期接口', () => {
  assert.equal(typeof adapterApi.listManagedToolAdapters, 'function');
  assert.equal(typeof adapterApi.getManagedToolAdapter, 'function');

  const adapters = adapterApi.listManagedToolAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.id), ['tmux', 'psmux', 'herdr', 'frpc']);
  for (const adapter of adapters) {
    assert.equal(typeof adapter.supports, 'function', `${adapter.id} supports`);
    assert.equal(typeof adapter.detect, 'function', `${adapter.id} detect`);
    assert.equal(typeof adapter.install, 'function', `${adapter.id} install`);
    assert.equal(typeof adapter.update, 'function', `${adapter.id} update`);
    assert.equal(typeof adapter.uninstall, 'function', `${adapter.id} uninstall`);
  }
});

test('每个受管工具在声明平台内独立生成完整生命周期计划', () => {
  const scenarios = [
    {
      options: macOptions({ commands: { brew: '/opt/homebrew/bin/brew' } }),
      executable: {
        tmux: '/opt/homebrew/bin/tmux',
        herdr: '/Users/tester/.local/bin/herdr',
        frpc: '/usr/local/bin/frpc'
      }
    },
    {
      options: linuxOptions({ commands: { 'apt-get': '/usr/bin/apt-get' } }),
      executable: {
        tmux: '/usr/bin/tmux',
        herdr: '/home/tester/.local/bin/herdr',
        frpc: '/usr/local/bin/frpc'
      }
    },
    {
      options: windowsOptions({ commands: { winget: 'winget.exe' } }),
      executable: {
        psmux: 'C:\\Tools\\psmux.exe',
        herdr: 'C:\\Users\\tester\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe',
        frpc: 'C:\\Tools\\frpc.exe'
      }
    }
  ];

  for (const scenario of scenarios) {
    for (const adapter of adapterApi.listManagedToolAdapters().filter((item) => item.supports(scenario.options))) {
      for (const action of ['install', 'update', 'uninstall']) {
        const installed = action !== 'install';
        const planned = adapter[action]({
          options: scenario.options,
          tool: {
            id: adapter.id,
            name: adapter.name,
            installed,
            executablePath: installed ? scenario.executable[adapter.id] : ''
          }
        });
        assert.ok(Array.isArray(planned), `${scenario.options.platform}/${adapter.id}/${action}`);
        assert.ok(planned.length > 0, `${scenario.options.platform}/${adapter.id}/${action}`);
        assert.ok(
          planned.every((plan) => plan.toolId === adapter.id
            && plan.action === action
            && plan.requiresConfirmation === true),
          `${scenario.options.platform}/${adapter.id}/${action} lifecycle contract`
        );
      }
    }
  }
});

test('资源清单只返回当前平台适用项且公共响应不暴露 supported 标签状态', () => {
  const mac = listManagedTools(macOptions()).tools;
  const linux = listManagedTools(linuxOptions()).tools;
  const windows = listManagedTools(windowsOptions()).tools;

  assert.deepEqual(mac.map((tool) => tool.id), ['tmux', 'herdr', 'frpc']);
  assert.deepEqual(linux.map((tool) => tool.id), ['tmux', 'herdr', 'frpc']);
  assert.deepEqual(windows.map((tool) => tool.id), ['psmux', 'herdr', 'frpc']);
  for (const tool of [...mac, ...linux, ...windows]) {
    assert.equal(Object.hasOwn(tool, 'supported'), false, `${tool.id} should not expose supported`);
  }
});

test('未安装 Herdr 在三平台都提供安装且已安装后提供更新和卸载', () => {
  const missingCases = [
    macOptions({ commands: { brew: '/opt/homebrew/bin/brew' } }),
    linuxOptions({ commands: {} }),
    windowsOptions({ commands: { winget: 'C:\\Windows\\System32\\winget.exe' } })
  ];
  for (const options of missingCases) {
    const herdr = listManagedTools(options).tools.find((tool) => tool.id === 'herdr');
    assert.ok(herdr);
    assert.equal(herdr.installed, false);
    assert.equal(herdr.canInstall, true);
  }

  const installedOptions = linuxOptions({ commands: { herdr: '/home/tester/.local/bin/herdr' } });
  const installed = listManagedTools(installedOptions).tools.find((tool) => tool.id === 'herdr');
  assert.equal(installed.installed, true);
  assert.equal(installed.canUpdate, true);
  assert.equal(installed.canUninstall, true);

  const update = planManagedToolAction({ toolId: 'herdr', action: 'update' }, installedOptions);
  assert.equal(update.ok, true);
  assert.equal(update.plans[0].command, '/home/tester/.local/bin/herdr');
  assert.deepEqual(update.plans[0].args, ['update']);

  const uninstall = planManagedToolAction({ toolId: 'herdr', action: 'uninstall' }, installedOptions);
  assert.equal(uninstall.ok, true);
  assert.match(uninstall.plans[0].id, /^herdr_uninstall_/);
});

test('Homebrew tmux 提供更新卸载和可持久保存的用户配置入口', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tmux-toolkit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const aiHomeDir = path.join(home, '.ai_home');
  const tmuxPath = '/opt/homebrew/bin/tmux';
  const options = macOptions({
    home,
    aiHomeDir,
    fs,
    commands: { tmux: tmuxPath, brew: '/opt/homebrew/bin/brew' }
  });

  const tmux = listManagedTools(options).tools.find((tool) => tool.id === 'tmux');
  assert.equal(tmux.installed, true);
  assert.equal(tmux.canUpdate, true);
  assert.equal(tmux.canUninstall, true);
  assert.equal(tmux.configEditable, true);
  assert.equal(tmux.configName, 'tmux.conf');

  const update = planManagedToolAction({ toolId: 'tmux', action: 'update' }, options);
  assert.equal(update.ok, true);
  assert.equal(update.plans[0].id, 'tmux_update_homebrew');
  const uninstall = planManagedToolAction({ toolId: 'tmux', action: 'uninstall' }, options);
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.plans[0].id, 'tmux_uninstall_homebrew');

  const opened = readManagedToolConfig('tmux', options);
  assert.equal(opened.content, '');
  assert.equal(opened.exists, false);
  const saved = saveManagedToolConfig('tmux', 'set -g mouse off\n', {
    ...options,
    expectedRevision: opened.revision,
    expectedTargetRevision: opened.targetRevision
  });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(path.join(aiHomeDir, 'config', 'tmux.conf'), 'utf8'), 'set -g mouse off\n');
});

test('生成的 tmux 和 psmux 透明配置会加载稳定用户 override 而不是编辑生成文件', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tmux-override-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const generated = path.join(home, 'run', 'tmux', 'tmux.conf');
  const override = path.join(home, 'config', 'tmux.conf');

  persistentSession.ensureTmuxConf(generated, fs, {
    platform: 'darwin',
    tmuxCommand: '/opt/homebrew/bin/tmux',
    cliName: 'codex',
    userConfigPath: override
  });
  const tmuxConfig = fs.readFileSync(generated, 'utf8');
  assert.match(tmuxConfig, /^set -s terminal-overrides\[99\] "\*:Sync@"$/m);
  assert.match(tmuxConfig, /source-file -q/);
  assert.match(tmuxConfig, /config\/tmux\.conf/);
  assert.ok(
    tmuxConfig.indexOf('terminal-overrides[99]') < tmuxConfig.indexOf('source-file -q'),
    '用户 override 应在 Codex 专属同步修复之后加载'
  );

  persistentSession.ensureTmuxConf(generated, fs, {
    platform: 'win32',
    tmuxCommand: 'psmux.exe',
    userConfigPath: override
  });
  const psmuxConfig = fs.readFileSync(generated, 'utf8');
  assert.match(psmuxConfig, /source-file -q/);
  assert.match(psmuxConfig, /config\/tmux\.conf/);
});

test('Windows psmux 自己维护 winget 安装更新卸载计划并在其他平台隐藏', () => {
  const missingOptions = windowsOptions({ commands: { winget: 'winget.exe' } });
  const missing = listManagedTools(missingOptions).tools.find((tool) => tool.id === 'psmux');
  assert.equal(missing.installed, false);
  assert.equal(missing.canInstall, true);

  const installedOptions = windowsOptions({
    commands: { psmux: 'C:\\Tools\\psmux.exe', winget: 'winget.exe' }
  });
  const installed = listManagedTools(installedOptions).tools.find((tool) => tool.id === 'psmux');
  assert.equal(installed.canUpdate, true);
  assert.equal(installed.canUninstall, true);
  assert.equal(installed.configEditable, true);

  for (const action of ['install', 'update', 'uninstall']) {
    const options = action === 'install' ? missingOptions : installedOptions;
    const planned = planManagedToolAction({ toolId: 'psmux', action }, options);
    assert.equal(planned.ok, true, action);
    assert.equal(planned.plans[0].command.toLowerCase(), 'winget.exe');
    assert.ok(planned.plans[0].args.includes('marlocarlo.psmux'));
  }

  assert.equal(listManagedTools(macOptions()).tools.some((tool) => tool.id === 'psmux'), false);
  assert.equal(listManagedTools(linuxOptions()).tools.some((tool) => tool.id === 'psmux'), false);
});

test('Herdr 直接安装的卸载器只删除确认的可执行文件并拒绝非 Herdr 目标', (t) => {
  assert.equal(typeof herdrUninstallRunner.executeHerdrUninstall, 'function');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-herdr-uninstall-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executablePath = path.join(home, '.local', 'bin', 'herdr');
  const unrelatedPath = path.join(home, '.local', 'bin', 'helper');
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, 'herdr');
  fs.writeFileSync(unrelatedPath, 'keep');

  const rejected = herdrUninstallRunner.executeHerdrUninstall({
    confirmed: true,
    platform: 'linux',
    hostHomeDir: home,
    targetPath: unrelatedPath,
    fs
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'herdr_uninstall_target_unsafe');

  const removed = herdrUninstallRunner.executeHerdrUninstall({
    confirmed: true,
    platform: 'linux',
    hostHomeDir: home,
    targetPath: executablePath,
    fs
  });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(executablePath), false);
  assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'keep');
});
