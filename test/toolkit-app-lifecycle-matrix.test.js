'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listManagedApps } = require('../lib/cli/services/toolkit/app-manager');
const { findIdeClientRecord, getIdeClient } = require('../lib/cli/services/toolkit/ide-client-registry');
const { getAppInstaller } = require('../lib/server/app-installers');

const PLATFORM_CASES = Object.freeze([
  Object.freeze({ platform: 'macos', processPlatform: 'darwin' }),
  Object.freeze({ platform: 'windows', processPlatform: 'win32' }),
  Object.freeze({ platform: 'linux', processPlatform: 'linux' })
]);

test('三平台所有可安装应用都提供更新和卸载计划', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-toolkit-app-matrix-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));

  for (const { platform, processPlatform } of PLATFORM_CASES) {
    const result = await listManagedApps({
      cacheInventory: false,
      platform,
      hostHomeDir: platform === 'windows' ? 'C:\\Users\\tester' : hostHomeDir,
      processObj: {
        platform: processPlatform,
        env: { PATH: '' },
        execPath: process.execPath
      },
      probeVersions: false
    });
    const installableApps = result.apps.filter((app) => app.installAvailable);
    const unmanagedApps = result.apps.filter((app) => !app.installAvailable);

    assert.ok(installableApps.length > 0, `${platform} 应返回可安装应用`);
    assert.deepEqual(
      unmanagedApps.map((app) => app.id),
      [],
      `${platform} 不应展示缺少安装生命周期的应用`
    );
    assert.ok(installableApps.some((app) => app.id === 'vscode' && app.type === 'ide'));
    assert.ok(installableApps.some((app) => app.id === 'cursor' && app.type === 'ide'));
    assert.ok(installableApps.some((app) => app.id === 'windsurf' && app.type === 'ide'));
    for (const app of installableApps) {
      assert.equal('updateReason' in app, false, `${platform}/${app.id} 不应保留更新缺失兜底`);
      assert.equal('uninstallReason' in app, false, `${platform}/${app.id} 不应保留卸载缺失兜底`);
      assert.equal(app.canUpdate, true, `${platform}/${app.id} 缺少更新计划`);
      assert.equal(app.canUninstall, true, `${platform}/${app.id} 缺少卸载计划`);
    }
  }
});

test('Windsurf 稳定标识同时识别当前 Devin Desktop 与旧版应用路径', () => {
  const client = getIdeClient('windsurf');
  assert.equal(client.name, 'Devin Desktop');

  for (const [bundleName, executableName] of [
    ['Devin.app', 'Devin'],
    ['Windsurf.app', 'Windsurf']
  ]) {
    const bundlePath = `/Applications/${bundleName}`;
    const executablePath = `${bundlePath}/Contents/MacOS/${executableName}`;
    const existing = new Set([bundlePath, executablePath]);
    const record = findIdeClientRecord('windsurf', {
      fs: { existsSync: (candidate) => existing.has(String(candidate)) },
      platform: 'macos',
      pathImpl: path.posix,
      hostHomeDir: '/Users/test',
      env: {}
    });
    assert.equal(record.bundlePath, bundlePath);
    assert.equal(record.executablePath, executablePath);
  }
});

test('Devin Desktop 三平台安装计划使用当前发行包标识', () => {
  const installer = getAppInstaller('windsurf');
  assert.ok(installer);
  const cases = [
    { platform: 'macos', processPlatform: 'darwin', expected: 'devin-desktop' },
    { platform: 'windows', processPlatform: 'win32', expected: 'Codeium.Windsurf' },
    { platform: 'linux', processPlatform: 'linux', expected: 'devin-desktop' }
  ];

  for (const scenario of cases) {
    const plans = installer.resolveLifecyclePlans('install', {
      kind: 'desktop',
      platform: scenario.platform,
      hostHomeDir: scenario.platform === 'windows' ? 'C:\\Users\\tester' : '/home/tester',
      processObj: { platform: scenario.processPlatform, env: {} }
    });
    assert.ok(plans.length > 0, `${scenario.platform} 缺少 Devin Desktop 安装计划`);
    assert.match(
      plans.map((plan) => [plan.command, ...(plan.args || [])].join(' ')).join('\n'),
      new RegExp(scenario.expected.replace('.', '\\.'))
    );
  }
});

test('Devin Desktop RPM 计划使用官方当前签名键与仓库路径', () => {
  const installer = getAppInstaller('windsurf');
  const plans = installer.resolveLifecyclePlans('install', {
    kind: 'desktop',
    platform: 'linux',
    hostHomeDir: '/home/tester',
    processObj: { platform: 'linux', env: {} }
  });
  const script = plans.map((plan) => (plan.args || []).join('\n')).join('\n');

  assert.match(script, /\/yum\/RPM-GPG-KEY-windsurf/);
  assert.match(script, /baseurl=https:\/\/windsurf-stable\.codeiumdata\.com\/wVxQEIWkwPUEAGf3\/yum\/repo\//);
});
