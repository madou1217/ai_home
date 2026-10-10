'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { detectNetworkLayer } = require('../lib/cli/services/toolkit/system-network-manager');

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
});
