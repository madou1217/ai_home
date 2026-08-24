'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const underlayPath = path.resolve(__dirname, '../lib/server/zcode-network-underlay.js');

function loadUnderlay() {
  assert.equal(fs.existsSync(underlayPath), true, '缺少 ZCode 物理网络 underlay 探测器');
  return require(underlayPath);
}

test('macOS underlay 从物理默认路由和同接口 scoped DNS 解析配置', () => {
  const {
    parseMacDefaultRouteInterface,
    parseMacScopedDnsServers
  } = loadUnderlay();
  const routeOutput = `
   route to: default
destination: default
    gateway: 192.168.31.1
  interface: en1
`;
  const dnsOutput = `
DNS configuration

resolver #1
  nameserver[0] : 127.0.0.1

resolver #2
  nameserver[0] : 114.114.114.114
  if_index : 15 (en1)
  flags    : Scoped, Request A records, Request AAAA records
`;

  assert.equal(parseMacDefaultRouteInterface(routeOutput), 'en1');
  assert.deepEqual(parseMacScopedDnsServers(dnsOutput, 'en1'), ['114.114.114.114']);
});

test('macOS underlay 拒绝 TUN/loopback，探测失败时显式 fail-closed', () => {
  const {
    parseMacDefaultRouteInterface,
    parseMacScopedDnsServers,
    resolveZcodeNetworkUnderlay
  } = loadUnderlay();

  assert.equal(parseMacDefaultRouteInterface('interface: utun1024'), '');
  assert.deepEqual(parseMacScopedDnsServers(`
resolver #1
  nameserver[0] : 127.0.0.1
  if_index : 1 (lo0)
`, 'lo0'), []);

  const commands = [];
  const result = resolveZcodeNetworkUnderlay({
    platform: 'darwin',
    spawnSync(command, args) {
      commands.push([command, args]);
      if (command === 'route') {
        return { status: 0, stdout: 'interface: en1\n', stderr: '' };
      }
      return { status: 0, stdout: 'resolver #1\n nameserver[0] : 127.0.0.1\n', stderr: '' };
    }
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'zcode_underlay_dns_unavailable',
    interfaceName: 'en1'
  });
  assert.deepEqual(commands, [
    ['route', ['-n', 'get', 'default']],
    ['scutil', ['--dns']]
  ]);
});

test('macOS underlay 探测结果只暴露经过校验的接口和 DNS', () => {
  const { resolveZcodeNetworkUnderlay } = loadUnderlay();
  const result = resolveZcodeNetworkUnderlay({
    platform: 'darwin',
    spawnSync(command) {
      if (command === 'route') {
        return { status: 0, stdout: 'interface: en1\n', stderr: '' };
      }
      return {
        status: 0,
        stdout: `resolver #1
  nameserver[0] : 114.114.114.114
  if_index : 15 (en1)
`,
        stderr: ''
      };
    }
  });

  assert.deepEqual(result, {
    ok: true,
    platform: 'macos',
    interfaceName: 'en1',
    dnsServer: '114.114.114.114'
  });
});

test('字面 IP 节点只要求物理接口，不把 DNS 缺失误判为不可用', () => {
  const { resolveZcodeNetworkUnderlay } = loadUnderlay();
  const result = resolveZcodeNetworkUnderlay({
    platform: 'darwin',
    requireDns: false,
    spawnSync(command) {
      if (command === 'route') {
        return { status: 0, stdout: 'interface: en1\n', stderr: '' };
      }
      return { status: 0, stdout: 'resolver #1\n nameserver[0] : 127.0.0.1\n', stderr: '' };
    }
  });

  assert.deepEqual(result, {
    ok: true,
    platform: 'macos',
    interfaceName: 'en1',
    dnsServer: ''
  });
});
