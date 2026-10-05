'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SYSTEM_PROXY_PLUGINS, getSystemProxyPlugin } = require('../lib/cli/services/toolkit/system-proxy-plugins');
const { detectSystemProxy } = require('../lib/cli/services/toolkit/proxy-manager');
const { detectTun, planSystemProxy, readSystemProxyCurrent } = require('../lib/cli/services/toolkit/system-network-manager');

test('系统代理插件：每个宿主平台一个插件，契约字段齐全', () => {
  assert.deepEqual(SYSTEM_PROXY_PLUGINS.map((plugin) => [plugin.id, plugin.hostPlatform]), [
    ['macos', 'darwin'],
    ['linux', 'linux'],
    ['windows', 'win32']
  ]);
  for (const plugin of SYSTEM_PROXY_PLUGINS) {
    assert.equal(plugin.capability, 'toolkit.system-proxy');
    assert.deepEqual(plugin.platforms, [plugin.id]);
    assert.equal(typeof plugin.requiresService, 'boolean');
    for (const method of ['detectProxy', 'readSnapshot', 'currentFromSnapshot', 'snapshotFor',
      'enableOperations', 'disableOperations', 'restoreOperations']) {
      assert.equal(typeof plugin[method], 'function', `${plugin.id}.${method}`);
    }
    for (const method of ['probe', 'interfaceDetected', 'routeDetected']) {
      assert.equal(typeof plugin.tun[method], 'function', `${plugin.id}.tun.${method}`);
    }
  }
  assert.equal(getSystemProxyPlugin('WIN32').id, 'windows');
  assert.equal(getSystemProxyPlugin('freebsd'), null);
});

test('不支持的平台：诊断、TUN 探测、快照与规划都明确返回不支持，且不执行任何命令', () => {
  const execCommand = () => assert.fail('不应执行命令');
  assert.equal(detectSystemProxy({ platform: 'freebsd', execCommand }).source, 'none');
  assert.equal(detectTun({ platform: 'freebsd', execCommand }).state, 'inactive');
  assert.equal(readSystemProxyCurrent('', { platform: 'freebsd', execCommand }).error, 'system_proxy_platform_unsupported');
  assert.equal(planSystemProxy({ platform: 'freebsd', action: 'disable' }).error, 'system_proxy_platform_unsupported');
});

test('readSystemProxyCurrent 只交出规划所需字段（macOS 不含服务名，其余平台去掉 ok）', () => {
  const ok = (stdout) => ({ status: 0, stdout });
  const mac = readSystemProxyCurrent('Wi-Fi', {
    platform: 'darwin',
    execCommand: (_command, args) => ok(args[0] === '-getautoproxyurl' ? 'URL: \nEnabled: No\n' : 'Enabled: No\nServer: \nPort: 0\n')
  });
  assert.deepEqual(Object.keys(mac.current), ['web', 'secureWeb', 'socks', 'pac']);
  const windows = readSystemProxyCurrent('', {
    platform: 'win32',
    execCommand: () => ok('    ProxyEnable    REG_DWORD    0x0\n')
  });
  assert.deepEqual(windows.current, { proxyEnable: 0, proxyServer: '', proxyOverride: '', autoConfigUrl: '' });
  assert.equal(readSystemProxyCurrent('', { platform: 'darwin' }).error, 'network_service_required');
});
