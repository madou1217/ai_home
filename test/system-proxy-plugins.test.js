'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SYSTEM_PROXY_PLUGINS, getSystemProxyPlugin } = require('../lib/cli/services/toolkit/system-proxy-plugins');
const { detectSystemProxy } = require('../lib/cli/services/toolkit/proxy-manager');
const { detectNetworkLayer, detectTun } = require('../lib/cli/services/toolkit/system-network-manager');

test('系统代理插件：每个宿主平台一个插件，只提供只读的代理与 TUN 探测', () => {
  assert.deepEqual(SYSTEM_PROXY_PLUGINS.map((plugin) => [plugin.id, plugin.hostPlatform]), [
    ['macos', 'darwin'],
    ['linux', 'linux'],
    ['windows', 'win32']
  ]);
  for (const plugin of SYSTEM_PROXY_PLUGINS) {
    assert.equal(plugin.capability, 'toolkit.system-proxy');
    assert.deepEqual(plugin.platforms, [plugin.id]);
    assert.equal(typeof plugin.detectProxy, 'function', `${plugin.id}.detectProxy`);
    for (const method of ['probe', 'interfaceDetected', 'routeDetected']) {
      assert.equal(typeof plugin.tun[method], 'function', `${plugin.id}.tun.${method}`);
    }
    for (const retired of ['readSnapshot', 'enableOperations', 'disableOperations', 'restoreOperations']) {
      assert.equal(plugin[retired], undefined, `${plugin.id}.${retired} 已随本地代理内核移除`);
    }
  }
  assert.equal(getSystemProxyPlugin('WIN32').id, 'windows');
  assert.equal(getSystemProxyPlugin('freebsd'), null);
});

test('不支持的平台：诊断与 TUN 探测明确返回不支持，且不执行任何命令', () => {
  const execCommand = () => assert.fail('不应执行命令');
  assert.equal(detectSystemProxy({ platform: 'freebsd', execCommand }).source, 'none');
  assert.equal(detectTun({ platform: 'freebsd', execCommand }).state, 'inactive');
});

test('网络层探测：TUN 归属按进程识别，系统代理与 TUN 决定实际路由', () => {
  const outputs = {
    ifconfig: 'utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>\n',
    netstat: 'default            utun4              UCSg            utun4\n',
    ps: '  501 /Applications/Clash Verge.app/Contents/MacOS/verge-mihomo -d /tmp\n'
  };
  const execCommand = (command) => ({ status: 0, stdout: outputs[command] || '' });
  const layer = detectNetworkLayer({
    platform: 'darwin',
    execCommand,
    systemProxy: { enabled: false }
  });
  assert.equal(layer.effectiveRoute, 'tun');
  assert.equal(layer.tun.owner, 'clash-verge');
  assert.equal(layer.takeoverAllowed, undefined);
  assert.equal(detectNetworkLayer({
    platform: 'darwin',
    systemProxy: { enabled: true },
    tun: { state: 'inactive' }
  }).effectiveRoute, 'system-proxy');
});
