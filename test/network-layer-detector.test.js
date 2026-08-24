'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const detectorPath = path.join(
  __dirname,
  '../lib/cli/services/toolkit/network-layer-detector.js'
);

test('系统网络只读探测拥有独立边界', () => {
  assert.equal(fs.existsSync(detectorPath), true);
});

const { detectNetworkLayer, detectTun } = require(detectorPath);

function commandResult(stdout = '', status = 0) {
  return { status, stdout, stderr: '' };
}

function commandHarness(entries) {
  const results = new Map(entries);
  return (command, args = []) => results.get(`${command} ${args.join(' ')}`)
    || commandResult('', 1);
}

test('detectTun 只读识别 macOS 上由外部客户端持有的 TUN', () => {
  const result = detectTun({
    platform: 'darwin',
    execCommand: commandHarness([
      ['ifconfig ', commandResult('utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>')],
      ['netstat -rn', commandResult('default 10.0.0.1 UGSc utun3')],
      ['ps -axo pid=,command=', commandResult('1234 /Applications/Clash Verge.app/Contents/MacOS/clash-verge')]
    ])
  });
  assert.equal(result.state, 'active');
  assert.equal(result.owner, 'clash-verge');
  assert.deepEqual(result.evidence, ['interface', 'route', 'process:clash-verge']);
});

test('detectTun 在没有接口与路由证据时返回 inactive', () => {
  const result = detectTun({
    platform: 'darwin',
    execCommand: () => commandResult('')
  });
  assert.equal(result.state, 'inactive');
  assert.equal(result.owner, null);
});

test('detectNetworkLayer 合并只读系统代理与 TUN 观察结果', () => {
  const result = detectNetworkLayer({
    platform: 'darwin',
    systemProxy: {
      enabled: true,
      httpsProxy: 'http://127.0.0.1:7890'
    },
    tun: {
      state: 'inactive',
      owner: null,
      evidence: []
    }
  });
  assert.equal(result.effectiveRoute, 'system-proxy');
  assert.equal(result.effectiveRouteKnown, true);
  assert.deepEqual(result.conflicts, []);
});

test('只读探测模块不包含系统代理、TUN 或代理核心写入能力', () => {
  const source = fs.readFileSync(detectorPath, 'utf8');
  assert.doesNotMatch(source, /planSystemProxy|executeSystemProxyPlan|networksetup.*-set|gsettings.*set|reg\.exe.*add/isu);
  assert.doesNotMatch(source, /mihomo|AIH_MIHOMO_BIN/iu);
});
