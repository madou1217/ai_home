'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  detectNetworkLayer,
  executeSystemProxyPlan,
  parseNetworksetupPac,
  parseNetworksetupProxy,
  planSystemProxy,
  readLinuxProxySnapshot,
  readWindowsProxySnapshot,
  readMacProxySnapshot
} = require('../lib/cli/services/toolkit/system-network-manager');

function commandResult(stdout = '', status = 0) {
  return { status, stdout, stderr: status === 0 ? '' : 'command failed' };
}

test('detectNetworkLayer reports an external Clash Verge TUN even when system proxy is off', () => {
  const outputs = new Map([
    ['scutil --proxy', commandResult('HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n')],
    ['ifconfig', commandResult('utun1024: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>\n\tinet 28.0.0.1 --> 28.0.0.1 netmask 0xffffff00\n')],
    ['netstat -rn', commandResult('default            28.0.0.1          UGScg           utun1024\n')],
    ['ps -axo pid=,command=', commandResult('15539 verge-mihomo\n13414 clash-verge\n')]
  ]);
  const result = detectNetworkLayer({
    platform: 'darwin',
    execCommand(command, args) {
      const key = `${command} ${args.join(' ')}`.trim();
      return outputs.get(key) || commandResult('', 1);
    },
    systemProxy: {
      platform: 'darwin',
      enabled: false,
      probeStatus: 'unset',
      source: 'scutil --proxy',
      httpProxy: '', httpsProxy: '', socksProxy: [], bypassList: []
    }
  });

  assert.equal(result.tun.state, 'active');
  assert.equal(result.tun.owner, 'clash-verge');
  assert.equal(result.effectiveRoute, 'tun');
  assert.equal(result.systemProxy.enabled, false);
  assert.equal(result.takeoverAllowed, false);
});

test('detectNetworkLayer marks an active Mihomo TUN owned by the AIH child process', () => {
  const outputs = new Map([
    ['ifconfig', commandResult('utun9: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>\n')],
    ['netstat -rn', commandResult('default            28.0.0.1          UGScg           utun9\n')],
    ['ps -axo pid=,command=', commandResult('4242 /Applications/Clash Verge.app/Contents/MacOS/verge-mihomo\n')]
  ]);
  const result = detectNetworkLayer({
    platform: 'darwin',
    ownedPid: 4242,
    execCommand(command, args) {
      return outputs.get(`${command} ${args.join(' ')}`.trim()) || commandResult('', 1);
    },
    systemProxy: { enabled: false, probeStatus: 'unset', source: 'test' }
  });

  assert.equal(result.tun.state, 'active');
  assert.equal(result.tun.owner, 'aih');
  assert.equal(result.takeoverAllowed, true);
  assert.deepEqual(result.conflicts, []);
});

test('planSystemProxy creates a snapshot-bound macOS plan for the AIH mixed endpoint', () => {
  const result = planSystemProxy({
    action: 'enable',
    platform: 'darwin',
    proxyUrl: 'http://127.0.0.1:10800',
    service: 'Wi-Fi',
    current: {
      service: 'Wi-Fi',
      web: { enabled: false, server: '', port: 0, bypass: [] },
      secureWeb: { enabled: false, server: '', port: 0, bypass: [] },
      socks: { enabled: false, server: '', port: 0, bypass: [] },
      pac: { enabled: false, url: '' }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.platform, 'darwin');
  assert.equal(result.plan.proxyUrl, 'http://127.0.0.1:10800');
  assert.match(result.plan.snapshotHash, /^[a-f0-9]{64}$/);
  assert.ok(result.plan.operations.some((operation) => operation.args.includes('-setwebproxy')));
});

test('readMacProxySnapshot parses networksetup output for web, secure, socks and PAC settings', () => {
  const outputs = new Map([
    ['networksetup -getwebproxy Wi-Fi', commandResult('Enabled: Yes\nServer: 127.0.0.1\nPort: 10800\nExceptions: localhost, 127.0.0.1\n')],
    ['networksetup -getsecurewebproxy Wi-Fi', commandResult('Enabled: No\nServer: old.proxy\nPort: 8080\n')],
    ['networksetup -getsocksfirewallproxy Wi-Fi', commandResult('Enabled: Yes\nServer: 127.0.0.1\nPort: 10800\n')],
    ['networksetup -getautoproxyurl Wi-Fi', commandResult('Enabled: No\nURL: http://127.0.0.1/proxy.pac\n')]
  ]);
  const result = readMacProxySnapshot('Wi-Fi', {
    execCommand(command, args) {
      return outputs.get(`${command} ${args.join(' ')}`) || commandResult('', 1);
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.web, { enabled: true, server: '127.0.0.1', port: 10800, bypass: ['localhost', '127.0.0.1'] });
  assert.deepEqual(result.secureWeb, { enabled: false, server: 'old.proxy', port: 8080, bypass: [] });
  assert.deepEqual(result.socks, { enabled: true, server: '127.0.0.1', port: 10800, bypass: [] });
  assert.deepEqual(result.pac, { enabled: false, url: 'http://127.0.0.1/proxy.pac' });
  assert.deepEqual(parseNetworksetupProxy('Enabled: Yes\nServer: x\nPort: 1\n'), { enabled: true, server: 'x', port: 1, bypass: [] });
  assert.deepEqual(parseNetworksetupPac('Enabled: Yes\nURL: http://x/pac\n'), { enabled: true, url: 'http://x/pac' });
});

test('planSystemProxy creates explicit disable and restore operations instead of silently doing nothing', () => {
  const current = {
    web: { enabled: true, server: 'old-http', port: 8080 },
    secureWeb: { enabled: false, server: '', port: 0 },
    socks: { enabled: true, server: 'old-socks', port: 1081 },
    pac: { enabled: true, url: 'http://old/pac' }
  };
  const disabled = planSystemProxy({ action: 'disable', platform: 'darwin', service: 'Wi-Fi', current });
  assert.equal(disabled.ok, true);
  assert.deepEqual(disabled.plan.operations.map((item) => item.args.slice(0, 2)), [
    ['-setwebproxystate', 'Wi-Fi'],
    ['-setsecurewebproxystate', 'Wi-Fi'],
    ['-setsocksfirewallproxystate', 'Wi-Fi'],
    ['-setautoproxystate', 'Wi-Fi']
  ]);
  const restored = planSystemProxy({ action: 'restore', platform: 'darwin', service: 'Wi-Fi', current });
  assert.equal(restored.ok, true);
  assert.ok(restored.plan.operations.some((item) => item.args[0] === '-setwebproxy' && item.args[2] === 'old-http'));
  assert.ok(restored.plan.operations.some((item) => item.args[0] === '-setautoproxyurl' && item.args[2] === 'http://old/pac'));
});

test('system proxy plans cover GNOME and Windows current-user settings with explicit rollback', () => {
  const linuxOutputs = new Map([
    ['gsettings get org.gnome.system.proxy mode', commandResult("'manual'\n")],
    ['gsettings get org.gnome.system.proxy.http host', commandResult("'old-http'\n")],
    ['gsettings get org.gnome.system.proxy.http port', commandResult('8080\n')],
    ['gsettings get org.gnome.system.proxy.https host', commandResult("'old-https'\n")],
    ['gsettings get org.gnome.system.proxy.https port', commandResult('8443\n')],
    ['gsettings get org.gnome.system.proxy.socks host', commandResult("'old-socks'\n")],
    ['gsettings get org.gnome.system.proxy.socks port', commandResult('1081\n')],
    ['gsettings get org.gnome.system.proxy autoconfig-url', commandResult("''\n")]
  ]);
  const linux = readLinuxProxySnapshot({
    execCommand(command, args) { return linuxOutputs.get(`${command} ${args.join(' ')}`) || commandResult('', 1); }
  });
  assert.equal(linux.ok, true);
  assert.equal(linux.mode, 'manual');
  assert.equal(linux.http.port, 8080);
  const linuxPlan = planSystemProxy({
    action: 'enable', platform: 'linux', proxyUrl: 'http://127.0.0.1:10800', current: linux
  });
  assert.equal(linuxPlan.ok, true);
  assert.ok(linuxPlan.plan.operations.some((item) => item.args.includes('org.gnome.system.proxy')));

  const windows = readWindowsProxySnapshot({
    execCommand(command) {
      assert.equal(command, 'reg.exe');
      return commandResult('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:8080\n');
    }
  });
  assert.equal(windows.ok, true);
  assert.equal(windows.proxyEnable, 1);
  const windowsPlan = planSystemProxy({
    action: 'disable', platform: 'win32', proxyUrl: 'http://127.0.0.1:10800', current: windows
  });
  assert.equal(windowsPlan.ok, true);
  assert.ok(windowsPlan.plan.operations.some((item) => item.command === 'reg.exe'));
});

test('planSystemProxy refuses AIH takeover while another TUN owner is active', () => {
  const result = planSystemProxy({
    action: 'enable',
    platform: 'darwin',
    proxyUrl: 'http://127.0.0.1:10800',
    network: { tun: { state: 'active', owner: 'clash-verge' } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'external_tun_active');
});

test('executeSystemProxyPlan requires confirmation and rolls back if a later operation fails', async () => {
  const calls = [];
  const plan = {
    platform: 'darwin',
    action: 'enable',
    proxyUrl: 'http://127.0.0.1:10800',
    service: 'Wi-Fi',
    snapshotHash: 'c'.repeat(64),
    operations: [
      { key: 'web', command: 'networksetup', args: ['-setwebproxy', 'Wi-Fi', '127.0.0.1', '10800'] },
      { key: 'secureWeb', command: 'networksetup', args: ['-setsecurewebproxy', 'Wi-Fi', '127.0.0.1', '10800'] }
    ],
    rollbackOperations: [
      { key: 'web-restore', command: 'networksetup', args: ['-setwebproxystate', 'Wi-Fi', 'off'] }
    ]
  };
  const result = await executeSystemProxyPlan(plan, {
    confirmed: true,
    expectedSnapshotHash: 'c'.repeat(64),
    execCommand(command, args) {
      calls.push([command, args]);
      return calls.length === 2 ? commandResult('', 1) : commandResult('', 0);
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'system_proxy_rollback_applied');
  assert.equal(result.rollbackApplied, true);
  assert.equal(calls.length, 3);
});
