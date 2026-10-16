'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeLifecycle,
  packageManagerLifecycle,
  resolveManagedToolDir
} = require('../lib/cli/services/toolkit/tool-lifecycle/package-manager-lifecycle');
const { listManagedTools, planManagedToolAction } = require('../lib/cli/services/toolkit/tool-manager');

const DESCRIPTOR = {
  homebrew: 'nginx',
  apt: { packages: ['nginx', 'libnginx-mod-stream'] },
  windowsArchive: { url: 'https://nginx.org/download/nginx-1.28.3.zip', binaryRelative: 'nginx-1.28.3/nginx.exe' }
};

const TOOL = { id: 'nginx', name: 'nginx', category: 'edge-entry', supported: true, installed: false, executablePath: '' };

test('入口软件插件化：nginx / caddy 作为受管工具出现在 edge-entry 分类里', () => {
  const listed = listManagedTools({});
  const ids = listed.tools.map((tool) => tool.id);
  assert.ok(ids.includes('nginx'), 'nginx 应该是受管工具');
  assert.ok(ids.includes('caddy'), 'caddy 应该是受管工具');
  for (const id of ['nginx', 'caddy']) {
    const tool = listed.tools.find((item) => item.id === id);
    assert.equal(tool.category, 'edge-entry');
    assert.ok(tool.capabilities.includes('config-edit'), `${id} 要能编辑配置`);
    assert.ok(tool.capabilities.includes('service'), `${id} 要能启停`);
  }
  assert.ok(listed.categories.some((category) => category.id === 'edge-entry'));
});

test('声明式生命周期：没装的工具在本机可装，装过的才谈得上更新/卸载', () => {
  const lifecycle = packageManagerLifecycle(DESCRIPTOR);
  const fresh = lifecycle.describe(TOOL, { platform: 'darwin' });
  assert.equal(fresh.canInstall, true);
  assert.equal(fresh.canUpdate, false);
  assert.equal(fresh.canUninstall, false);
  assert.equal(fresh.method, 'homebrew');

  // 外部自装的：AIH 不动它（只说得出「谁装的」，不给卸载计划）。
  const external = lifecycle.describe(
    { ...TOOL, installed: true, executablePath: '/usr/bin/nginx' },
    { platform: 'darwin' }
  );
  assert.equal(external.managedBy, 'external');
  assert.equal(external.canUninstall, false);
  assert.equal(external.canUpdate, false);

  // AIH 自管目录里的那份：可更新可卸载。
  const managedDir = resolveManagedToolDir('nginx', { platform: 'win32', env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' } });
  const managed = lifecycle.describe(
    { ...TOOL, installed: true, executablePath: `${managedDir}\\nginx-1.28.3\\nginx.exe` },
    { platform: 'win32', env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' } }
  );
  assert.equal(managed.managedBy, 'aih');
  assert.equal(managed.canUninstall, true);
});

test('安装计划按平台给真命令：Homebrew / apt（免密 sudo）/ Windows 官方压缩包', () => {
  const plan = (platform) => planManagedToolAction({ toolId: 'nginx', action: 'install' }, { platform });

  const mac = plan('darwin');
  assert.equal(mac.ok, true);
  assert.equal(mac.plans[0].method, 'homebrew');
  assert.match(mac.plans[0].preview, /brew install nginx$/);

  const linux = plan('linux');
  assert.equal(linux.ok, true);
  assert.equal(linux.plans[0].method, 'apt');
  assert.deepEqual(linux.plans[0].command.endsWith('sudo') ? linux.plans[0].args.slice(0, 4) : linux.plans[0].args.slice(0, 4),
    ['-n', 'apt-get', 'install', '-y']);
  // 包必须逐个成参数：拼成一整个字符串会变成"找不到这个包"。
  assert.ok(linux.plans[0].args.includes('nginx'));
  assert.ok(linux.plans[0].args.includes('libnginx-mod-stream'));

  const win = plan('win32');
  assert.equal(win.ok, true);
  assert.equal(win.plans[0].method, 'archive');
  assert.equal(win.plans[0].command, 'powershell');
  assert.match(win.plans[0].args.join(' '), /Expand-Archive/);
});

test('Linux 上系统包装的（apt）算包管理器管理：可更新、可卸载，但绝不动外部自装的那份', () => {
  const lifecycle = packageManagerLifecycle(DESCRIPTOR);
  const apt = lifecycle.describe(
    { ...TOOL, installed: true, executablePath: '/usr/sbin/nginx' },
    { platform: 'linux' }
  );
  assert.equal(apt.managedBy, 'apt');
  assert.equal(apt.canUpdate, true);
  assert.equal(apt.canUninstall, true);

  const homemade = lifecycle.describe(
    { ...TOOL, installed: true, executablePath: '/opt/nginx-src/sbin/nginx' },
    { platform: 'darwin' }
  );
  assert.equal(homemade.managedBy, 'external');
  assert.equal(homemade.canUpdate, false);
  assert.equal(homemade.canUninstall, false);
});

test('没有可自动执行的安装方式时明确说不，而不是给一条没法确认的命令', () => {
  const lifecycle = packageManagerLifecycle({ homebrew: 'nginx' });
  const result = lifecycle.resolvePlans(TOOL, 'install', { platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'managed_tool_lifecycle_unavailable');
  assert.match(result.message, /Linux/);
});

test('已装/未装的边界由状态决定，不靠界面判断', () => {
  const lifecycle = packageManagerLifecycle(DESCRIPTOR);
  assert.equal(lifecycle.resolvePlans({ ...TOOL, installed: true }, 'install', { platform: 'darwin' }).error, 'managed_tool_already_installed');
  assert.equal(lifecycle.resolvePlans(TOOL, 'uninstall', { platform: 'darwin' }).error, 'managed_tool_not_installed');
});
