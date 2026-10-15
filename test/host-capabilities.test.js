'use strict';

// 宿主机能力门面（P1）回归。
//
// 这一层存在的意义是：桌面环境 / 应用已装 / 可否安装 三件事各自已有实现，但消费方（认证来源链、
// 添加账号 UI）不该各自去读检测器与安装器注册表。这里守住三件事：纯函数判定、注入可测、
// 以及与既有安装判定**同结论**（防止两处规则漂移）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostCapabilities, isDesktopHost, normalizeKind } = require('../lib/runtime/host-capabilities');

test('桌面环境判定：macOS / Windows 恒真，Linux 看图形会话', () => {
  assert.equal(isDesktopHost({ platform: 'darwin', env: {} }), true);
  assert.equal(isDesktopHost({ platform: 'win32', env: {} }), true);
  assert.equal(isDesktopHost({ platform: 'linux', env: { DISPLAY: ':0' } }), true);
  assert.equal(isDesktopHost({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), true);
  assert.equal(isDesktopHost({ platform: 'linux', env: {} }), false);
  assert.equal(isDesktopHost({ platform: 'freebsd', env: { DISPLAY: ':0' } }), false);
  assert.equal(isDesktopHost({}), false);
  assert.equal(normalizeKind('CLI'), 'cli');
  assert.equal(normalizeKind('bogus'), 'desktop');
});

/** 注入替身：不碰真实进程扫描 / 文件系统。 */
function capabilitiesFor({ entries = {}, installer = null, platform = 'darwin', env = {} } = {}) {
  return createHostCapabilities({
    processObj: { platform, env },
    env,
    appEntryDetector: { detect: () => entries, invalidate() {} },
    getAppInstaller: () => installer,
    getProviderDefinition: () => ({ clients: { cli: true, desktop: true } }),
    normalizePlatform: (value) => (value === 'darwin' ? 'macos' : value === 'win32' ? 'windows' : 'linux')
  });
}

test('应用已装：直接反映宿主检测结果（不自己实现探测）', () => {
  const host = capabilitiesFor({ entries: { kiro: { desktop: true, cli: false } } });
  assert.equal(host.appAvailable('kiro', 'desktop'), true);
  assert.equal(host.appAvailable('kiro', 'cli'), false);
  assert.equal(host.appAvailable('KIRO', 'desktop'), true, 'provider 名大小写不敏感');
  assert.equal(host.appAvailable('codex', 'desktop'), false);
  assert.equal(host.appAvailable('', 'desktop'), false);
});

test('可否安装：权威判定来自安装器自己的 resolveDesktopInstallPlans（平台不匹配 → 空数组）', () => {
  // 与 createProviderInstaller 拍平后的真实形状一致：平台支持与否由 options.platform 决定。
  const installer = {
    resolveDesktopInstallPlans: (options = {}) => (options.platform === 'darwin' ? [{ command: 'brew' }] : []),
    installCli: () => {}
  };
  assert.equal(capabilitiesFor({ installer, platform: 'darwin' }).canInstall('kiro', 'desktop'), true);
  assert.equal(capabilitiesFor({ installer, platform: 'linux' }).canInstall('kiro', 'desktop'), false);
  assert.equal(capabilitiesFor({ installer }).canInstall('kiro', 'cli'), true);
  assert.equal(capabilitiesFor({ installer: null }).canInstall('kiro', 'desktop'), false);
  assert.equal(capabilitiesFor({ installer: null }).canInstall('', 'desktop'), false);
  // 安装器内部抛错 → 保守回答不可安装，绝不乐观放行。
  assert.equal(capabilitiesFor({
    installer: { resolveDesktopInstallPlans: () => { throw new Error('probe_failed'); } }
  }).canInstall('kiro', 'desktop'), false);
});

test('describeProvider：区分「已装」「未装但可装」「不可用」，原因可观察', () => {
  const installer = { resolveDesktopInstallPlans: () => [{ command: 'brew' }], installCli: () => {} };
  const installed = capabilitiesFor({
    entries: { kiro: { desktop: true, cli: true } }, installer
  }).describeProvider('kiro');
  assert.equal(installed.desktop.available, true);
  assert.equal(installed.desktop.installable, false);
  assert.equal(installed.desktop.reason, '');

  const installable = capabilitiesFor({
    entries: { kiro: { desktop: false, cli: false } }, installer
  }).describeProvider('kiro');
  assert.equal(installable.desktop.available, false);
  assert.equal(installable.desktop.installable, true);
  assert.equal(installable.desktop.reason, 'not_installed_installable');

  const unavailable = capabilitiesFor({ entries: {} }).describeProvider('kiro');
  assert.equal(unavailable.desktop.available, false);
  assert.equal(unavailable.desktop.installable, false);
  assert.equal(unavailable.desktop.reason, 'not_available');
});

test('CLI 安装判定必须与既有 isCliInstallSupported 同结论（防两处规则漂移）', () => {
  const { PROVIDER_IDS } = require('../lib/provider-catalog');
  const { isCliInstallSupported } = require('../lib/server/app-install-job-manager');
  const host = createHostCapabilities({ processObj: { platform: process.platform, env: process.env }, env: process.env });
  for (const provider of PROVIDER_IDS) {
    assert.equal(host.canInstall(provider, 'cli'), isCliInstallSupported(provider),
      `provider ${provider} 的 CLI 安装判定与 app-install-job-manager 不一致`);
  }
});

test('真实宿主机自检：能给出桌面环境与应用可用性结论（不依赖具体机器事实）', () => {
  const host = createHostCapabilities({ hostHomeDir: require('node:os').homedir() });
  const described = host.describeHost();
  assert.equal(typeof described.desktop, 'boolean');
  assert.equal(typeof described.platformKey, 'string');
  const kiro = host.describeProvider('kiro');
  assert.equal(typeof kiro.desktop.available, 'boolean');
  assert.equal(typeof kiro.desktop.installable, 'boolean');
  // 不可用时必须给得出原因（UI 靠它决定显示「安装后可用」还是「不可用」）。
  assert.ok(kiro.desktop.available || kiro.desktop.reason);
  if (process.platform === 'darwin') {
    // kiro 安装器在 macOS 上声明了桌面安装计划（实测路径 /Applications/Kiro.app）。
    assert.equal(host.canInstall('kiro', 'desktop'), true, 'macOS 上 kiro 桌面应可安装');
  }
});
