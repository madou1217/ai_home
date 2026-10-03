'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ENVIRONMENT_RUNTIME_PLUGINS, getRuntimePluginForTool } = require('../lib/cli/services/toolkit/environment/plugins');
const { resolveEnvironmentToolPlans } = require('../lib/cli/services/toolkit/environment/lifecycle');
const { getEnvironmentsSummary } = require('../lib/cli/services/toolkit/environment/resource-manager');
const { probeEnvironmentTool } = require('../lib/cli/services/toolkit/environment/probe');
const { getEnvironmentTool } = require('../lib/cli/services/toolkit/environment/catalog');

function planScripts(result) {
  return result.plans.map((plan) => plan.args.join(' '));
}

test('运行环境插件注册表按顺序提供 Node / Python / Rust / Go 且工具 ID 唯一', () => {
  assert.deepEqual(ENVIRONMENT_RUNTIME_PLUGINS.map((plugin) => plugin.id), ['node', 'python', 'rust', 'go']);
  const toolIds = ENVIRONMENT_RUNTIME_PLUGINS.flatMap((plugin) => plugin.tools.map((tool) => tool.id));
  assert.equal(new Set(toolIds).size, toolIds.length);
  for (const plugin of ENVIRONMENT_RUNTIME_PLUGINS) {
    assert.equal(typeof plugin.detectRuntime, 'function');
    assert.equal(typeof plugin.resolvePlans, 'function');
    for (const tool of plugin.tools) {
      assert.equal(tool.runtime, plugin.id);
      assert.equal(getRuntimePluginForTool(tool.id), plugin);
    }
  }
});

test('rustup 安装计划非交互执行，Windows 走 WinGet 并带 rustup.exe 自卸载', () => {
  const posix = resolveEnvironmentToolPlans('rustup', 'install', { platform: 'linux', hostHomeDir: '/home/tester' });
  assert.equal(posix.ok, true);
  assert.match(planScripts(posix)[0], /sh\.rustup\.rs/);
  assert.match(planScripts(posix)[0], /bash "\$tmp" '-y'/);

  const update = resolveEnvironmentToolPlans('rustup', 'update', { platform: 'macos', hostHomeDir: '/Users/tester' });
  assert.match(planScripts(update)[0], /\/Users\/tester\/\.cargo\/bin\/rustup/);
  assert.match(planScripts(update)[0], /"\$rustup_bin" update/);

  const windowsInstall = resolveEnvironmentToolPlans('rustup', 'install', { platform: 'windows', hostHomeDir: 'C:\\Users\\tester' });
  assert.equal(windowsInstall.plans[0].method, 'WinGet');
  assert.ok(windowsInstall.plans[0].args.includes('Rustlang.Rustup'));
  const windowsUninstall = resolveEnvironmentToolPlans('rustup', 'uninstall', { platform: 'windows', hostHomeDir: 'C:\\Users\\tester' });
  assert.equal(windowsUninstall.plans[0].command, 'C:\\Users\\tester\\.cargo\\bin\\rustup.exe');
  assert.deepEqual(windowsUninstall.plans[0].args, ['self', 'uninstall', '-y']);
});

test('Go 用户级安装校验 SHA-256 并写入带标记的 PATH，卸载按同一标记清理', () => {
  const install = resolveEnvironmentToolPlans('go', 'install', { platform: 'linux', hostHomeDir: '/home/tester' });
  assert.equal(install.ok, true);
  const script = planScripts(install)[0];
  assert.match(script, /go\.dev\/VERSION\?m=text/);
  assert.match(script, /\.sha256/);
  assert.match(script, /'\/home\/tester\/\.local\/go'/);
  assert.match(script, /# aih-go/);

  const uninstall = resolveEnvironmentToolPlans('go', 'uninstall', { platform: 'linux', hostHomeDir: '/home/tester' });
  assert.match(planScripts(uninstall)[0], /# aih-go/);
  assert.match(planScripts(uninstall)[0], /\/home\/tester\/\.local\/go/);

  const macos = resolveEnvironmentToolPlans('go', 'update', { platform: 'macos', hostHomeDir: '/Users/tester' });
  assert.deepEqual(macos.plans.map((plan) => plan.method), ['Homebrew', 'go.dev 官方发布包']);

  const windows = resolveEnvironmentToolPlans('go', 'install', { platform: 'windows', hostHomeDir: 'C:\\Users\\tester' });
  assert.ok(windows.plans[0].args.includes('GoLang.Go'));
  assert.equal(resolveEnvironmentToolPlans('goenv', 'install', { platform: 'windows' }).error, 'unsupported_platform');
});

test('PATH 探测失败时按插件声明的已知安装位置识别用户级工具', () => {
  const home = '/home/tester';
  const rustupPath = path.posix.join(home, '.cargo', 'bin', 'rustup');
  const options = {
    platform: 'linux',
    hostHomeDir: home,
    path: path.posix,
    fs: { existsSync: (target) => target === rustupPath },
    spawnSync(command, args) {
      if (command === rustupPath && args[0] === '--version') return { status: 0, stdout: 'rustup 1.28.2 (e4f3ad6f8 2025-04-28)\n', stderr: '' };
      if (command === rustupPath && args[0] === 'toolchain') return { status: 0, stdout: 'stable-x86_64-unknown-linux-gnu (default)\nnightly-x86_64-unknown-linux-gnu\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'not found' };
    }
  };
  const observed = probeEnvironmentTool(getEnvironmentTool('rustup'), options);
  assert.equal(observed.installed, true);
  assert.equal(observed.version, '1.28.2');
  assert.equal(observed.executablePath, rustupPath);
  assert.deepEqual(observed.managedVersions, ['stable-x86_64-unknown-linux-gnu', 'nightly-x86_64-unknown-linux-gnu']);
});

test('运行环境摘要只返回当前平台有工具的运行时插件，并提供动态 runtimes', () => {
  const summary = getEnvironmentsSummary({
    platform: 'windows',
    hostHomeDir: 'C:\\Users\\tester',
    fs: { existsSync: () => false, readdirSync: () => [] },
    spawnSync() { return { status: 1, stdout: '', stderr: '' }; }
  });
  assert.deepEqual(summary.runtimePlugins.map((plugin) => plugin.id), ['node', 'python', 'rust', 'go']);
  assert.ok(summary.runtimes.rust);
  assert.ok(summary.runtimes.go);
  assert.equal(summary.resources.some((resource) => resource.id === 'goenv'), false);
  assert.equal(summary.resources.some((resource) => resource.id === 'go'), true);
  assert.ok(summary.environments.node);
});
