'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listProviderDefinitions } = require('../lib/provider-catalog');
const { getAppInstaller, listManagedAppInstallers, INSTALLERS } = require('../lib/server/app-installers');
const {
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan
} = require('../lib/server/app-installers/official-install');

test('每个合同 CLI Provider 都由独立安装器模块提供统一入口', () => {
  const providers = listProviderDefinitions()
    .filter((definition) => definition.clients && definition.clients.cli)
    .map((definition) => definition.id);
  assert.ok(providers.length > 0);
  providers.forEach((provider) => {
    const installer = getAppInstaller(provider);
    assert.ok(installer, `${provider} must have an independent installer module`);
    assert.equal(installer.provider, provider);
    assert.equal(typeof installer.install, 'function');
    assert.equal(typeof installer.update, 'function');
    assert.equal(typeof installer.uninstall, 'function');
    assert.equal(typeof installer.installCli, 'function');
    assert.equal(typeof installer.resolveDesktopInstallPlans, 'function');
  });
  providers.forEach((provider) => assert.ok(Object.prototype.hasOwnProperty.call(INSTALLERS, provider)));
});

test('ZCode 安装器只提供 Desktop 能力，不暴露 CLI 安装入口', () => {
  const zcode = getAppInstaller('zcode');
  assert.ok(zcode);
  assert.equal(typeof zcode.installCli, 'undefined');
  assert.equal(typeof zcode.resolveCliInstallPlans, 'undefined');
  assert.equal(typeof zcode.listCliBinaryNames, 'undefined');
  assert.equal(typeof zcode.resolveDesktopInstallPlans, 'function');
});

test('注册表发现的每个独立 Provider 安装器都实现生命周期接口', () => {
  const installers = Object.values(INSTALLERS);
  assert.ok(installers.length > 0);
  installers.forEach((installer) => {
    assert.equal(typeof installer.install, 'function', `${installer.provider} must implement install()`);
    assert.equal(typeof installer.update, 'function', `${installer.provider} must implement update()`);
    assert.equal(typeof installer.uninstall, 'function', `${installer.provider} must implement uninstall()`);
  });
});

test('独立托管 CLI 不污染 Provider 合同，并通过同一生命周期接口注册', () => {
  const dsh = getAppInstaller('dsh');
  assert.ok(dsh);
  assert.equal(dsh.managedApp.id, 'dsh');
  assert.equal(dsh.managedApp.type, 'cli');
  assert.equal(dsh.listCliBinaryNames()[0], 'dsh');
  assert.deepEqual(listManagedAppInstallers().map((installer) => installer.provider), ['dsh']);
  assert.deepEqual(dsh.resolveLifecyclePlans('update', { kind: 'cli' }).map((plan) => plan.id), ['npm_global_update']);
  assert.deepEqual(dsh.resolveLifecyclePlans('uninstall', { kind: 'cli' }).map((plan) => plan.id), ['npm_global_uninstall']);
});

test('桌面安装参数只来自对应 Provider 安装器', () => {
  const codex = getAppInstaller('codex');
  const claude = getAppInstaller('claude');
  const zcode = getAppInstaller('zcode');
  const gemini = getAppInstaller('gemini');
  const grok = getAppInstaller('grok');

  assert.deepEqual(codex.resolveDesktopInstallPlans({ platform: 'darwin' })[0].args, [
    'install', '--cask', 'chatgpt'
  ]);
  assert.deepEqual(claude.resolveDesktopInstallPlans({ platform: 'win32' })[0].args.slice(0, 4), [
    'install', '--id', 'Anthropic.Claude', '--exact'
  ]);
  assert.equal(zcode.resolveDesktopInstallPlans({ platform: 'darwin' })[0].id, 'zcode_desktop_macos_official_page');
  assert.deepEqual(gemini.resolveDesktopInstallPlans({ platform: 'darwin' }), []);
  assert.deepEqual(grok.resolveDesktopInstallPlans({ platform: 'darwin' }), []);
});

test('安装器公共平台接口使用 macos/windows/linux，兼容 Node 别名输入', () => {
  const codex = getAppInstaller('codex');
  const claude = getAppInstaller('claude');
  assert.equal(codex.resolveDesktopInstallPlans({ platform: 'macos' })[0].command, 'brew');
  assert.equal(claude.resolveDesktopInstallPlans({ platform: 'windows' })[0].command, 'winget.exe');
  assert.equal(codex.resolveDesktopInstallPlans({ platform: 'win32' })[0].command, 'winget.exe');
});

test('npm 生命周期计划隔离用户配置并固定公共 registry', () => {
  const packageName = '@example/provider-cli';
  const builders = [
    buildNpmPlan,
    buildNpmUpdatePlan,
    buildNpmUninstallPlan
  ];

  for (const platform of ['macos', 'linux', 'windows']) {
    const expectedUserConfig = platform === 'windows' ? 'NUL' : '/dev/null';
    const expectedCommand = platform === 'windows' ? 'npm.cmd' : 'npm';
    for (const buildPlan of builders) {
      const plan = buildPlan(packageName, { platform });
      assert.equal(plan.command, expectedCommand);
      assert.ok(plan.args.includes(`--userconfig=${expectedUserConfig}`));
      assert.ok(plan.args.includes('--registry=https://registry.npmjs.org'));
    }
  }
});

test('官方安装器优先使用可验证的稳定下载端点，并覆盖 Windows CMD 兜底', () => {
  const agy = getAppInstaller('agy');
  const agyWindowsCli = agy.resolveCliInstallPlans({ platform: 'windows' });
  assert.deepEqual(agyWindowsCli.map((plan) => plan.id), [
    'agy_windows_official',
    'agy_windows_cmd_official'
  ]);
  assert.equal(agyWindowsCli[1].command, 'cmd.exe');
  assert.ok(agyWindowsCli[1].args.at(-1).includes('https://antigravity.google/cli/install.cmd'));

  const claude = getAppInstaller('claude');
  assert.deepEqual(claude.resolveCliInstallPlans({ platform: 'windows' }).map((plan) => plan.id), [
    'claude_windows_official',
    'claude_windows_cmd_official',
    'winget'
  ]);

  const opencode = getAppInstaller('opencode');
  const opencodeWindows = opencode.resolveDesktopInstallPlans({ platform: 'windows' });
  assert.equal(opencodeWindows[0].id, 'opencode_desktop_windows_official');
  assert.match(opencodeWindows[0].args.join(' '), /dev\.opencode\.ai\/download\/stable\/windows-x64-nsis/);
  const opencodeLinux = opencode.resolveDesktopInstallPlans({ platform: 'linux' });
  assert.deepEqual(opencodeLinux.map((plan) => plan.id), [
    'opencode_desktop_linux_deb',
    'opencode_desktop_linux_rpm'
  ]);

  const zcode = getAppInstaller('zcode');
  const zcodeLinux = zcode.resolveDesktopInstallPlans({ platform: 'linux' })[0];
  assert.ok(zcodeLinux.args.join(' ').includes('.AppImage'));
});

test('Desktop 安装器只在官方资料声明的架构上提供计划', () => {
  const armLinux = { platform: 'linux', processObj: { platform: 'linux', arch: 'arm64', env: {} } };
  assert.deepEqual(getAppInstaller('zcode').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('kiro').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('opencode').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('qoder').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('qodercn').resolveDesktopInstallPlans(armLinux), []);

  const armWindows = { platform: 'windows', processObj: { platform: 'win32', arch: 'arm64', env: {} } };
  assert.equal(getAppInstaller('zcode').resolveDesktopInstallPlans(armWindows).length, 1);
  assert.deepEqual(getAppInstaller('opencode').resolveDesktopInstallPlans(armWindows), []);
});
