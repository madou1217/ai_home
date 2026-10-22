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

// 2026-10-21 报障：Surge 用 TUN 模式接管流量时，`scutil --proxy` 的汇总视图显示
// HTTPEnable: 0，而 Wi-Fi 服务上 127.0.0.1:6152 是配好的、也确实能用。只读 scutil
// 会让「现有系统代理」这个出口在用户明明有代理时报「不可用」，保存即回滚。
test('macOS：汇总视图没有代理时，回落到按网络服务读取', () => {
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'scutil') return { status: 0, stdout: '<dictionary> { HTTPEnable : 0 HTTPSEnable : 0 SOCKSEnable : 0 }', stderr: '' };
    if (args[0] === '-listnetworkserviceorder') {
      return { status: 0, stdout: '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en1)\n', stderr: '' };
    }
    if (args[0] === '-getwebproxy') return { status: 0, stdout: 'Enabled: Yes\nServer: 127.0.0.1\nPort: 6152\n', stderr: '' };
    if (args[0] === '-getsecurewebproxy') return { status: 0, stdout: 'Enabled: Yes\nServer: 127.0.0.1\nPort: 6152\n', stderr: '' };
    if (args[0] === '-getsocksfirewallproxy') return { status: 0, stdout: 'Enabled: No\nServer: \nPort: 0\n', stderr: '' };
    if (args[0] === '-getproxybypassdomains') return { status: 0, stdout: '*.local\n169.254/16\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = detectSystemProxy({ processObj: { platform: 'darwin', env: {} }, spawnSync });
  assert.equal(result.enabled, true);
  assert.equal(result.probeStatus, 'available');
  assert.equal(result.source, 'networksetup -getwebproxy');
  assert.equal(result.httpProxy, 'http://127.0.0.1:6152');
  assert.equal(result.httpsProxy, 'http://127.0.0.1:6152');
  assert.equal(result.socksProxy, '');
  assert.deepEqual(result.bypassList, ['*.local', '169.254/16']);
  assert.ok(calls.some((line) => line.startsWith('networksetup -getwebproxy')));
});

test('macOS：汇总视图有代理时不再多问网络服务（保持原有单一来源）', () => {
  const calls = [];
  const result = detectSystemProxy({
    processObj: { platform: 'darwin', env: {} },
    spawnSync: (command, args) => {
      calls.push([command, ...args].join(' '));
      return { status: 0, stdout: '<dictionary> { HTTPEnable : 1 HTTPProxy : 10.0.0.9 HTTPPort : 7890 }', stderr: '' };
    }
  });
  assert.equal(result.source, 'scutil --proxy');
  assert.equal(result.httpProxy, 'http://10.0.0.9:7890');
  assert.equal(calls.filter((line) => line.startsWith('networksetup')).length, 0);
});

test('macOS：网络服务也没配代理时如实报告未设置', () => {
  const result = detectSystemProxy({
    processObj: { platform: 'darwin', env: {} },
    spawnSync: (command, args) => {
      if (command === 'scutil') return { status: 0, stdout: '<dictionary> { HTTPEnable : 0 }', stderr: '' };
      if (args[0] === '-listnetworkserviceorder') return { status: 0, stdout: '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en1)\n', stderr: '' };
      return { status: 0, stdout: 'Enabled: No\nServer: \nPort: 0\n', stderr: '' };
    }
  });
  assert.equal(result.enabled, false);
  assert.equal(result.probeStatus, 'unset');
});
