'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { checkLaunchNetwork, readEnvBaseUrls } = require('../lib/runtime/egress-launch-guard');
const { evaluateNetworkExit, exitKeyOf, describeNetworkDenial } = require('../lib/runtime/egress-network-guard');
const { applyAccountEgressProxyEnv } = require('../lib/runtime/account-egress-proxy');
const gatewayGuard = require('../lib/server/egress-network-guard-gateway');
const { writeUpstreamPolicy } = require('../lib/server/egress-region-policy');

const CN = { geo: { country: 'CN', region: 'Shanghai', city: 'Shanghai', ip: '1.2.3.4' }, at: Date.now() };
const JP = { geo: { country: 'JP', region: 'Tokyo', city: 'Tokyo', ip: '5.6.7.8' }, at: Date.now() };

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-net-guard-'));
}

test('exit keys never carry proxy credentials', () => {
  assert.equal(exitKeyOf(''), 'direct');
  assert.equal(exitKeyOf('http://user:pass@127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('evaluateNetworkExit: hint denies mainland, unknown geo is allowed, no policy = null', () => {
  const context = { policy: { rules: [] }, hints: [{ id: 'h', effect: 'deny', match: { country: ['CN'], region: [], city: [], asn: [], cidr: [], nodes: [], groups: [] } }], evidence: {} };
  assert.equal(evaluateNetworkExit(context, CN).status, 'denied');
  assert.match(evaluateNetworkExit(context, CN).geoText, /CN/);
  assert.equal(evaluateNetworkExit(context, JP).status, 'unknown');
  assert.equal(evaluateNetworkExit(context, null).status, 'unknown');
  assert.equal(evaluateNetworkExit({ policy: { rules: [] }, hints: [] }, CN), null);
  assert.match(describeNetworkDenial(evaluateNetworkExit(context, CN), 'api.anthropic.com'), /设置出口/);
});

test('launch guard: claude official upstream from mainland is refused; gateway-mode and pool launches skip', () => {
  const home = tempHome();
  try {
    const lookups = [];
    const lookupSync = (input) => { lookups.push(input.proxyUrl); return input.proxyUrl ? JP : CN; };
    const denial = checkLaunchNetwork({ env: {}, provider: 'claude', accountRef: 'a', egress: { bound: false }, fs, aiHomeDir: home, lookupSync });
    assert.ok(denial, 'direct mainland exit is denied');
    assert.match(denial.reason, /CN/);
    // 继承的环境代理在日本：放行。
    assert.equal(checkLaunchNetwork({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, provider: 'claude', egress: { bound: false }, fs, aiHomeDir: home, lookupSync }), null);
    // 指向本机网关：由网关守卫负责。
    assert.equal(checkLaunchNetwork({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' }, provider: 'claude', egress: { bound: false }, fs, aiHomeDir: home, lookupSync }), null);
    // 出口池：车道负责。
    assert.equal(checkLaunchNetwork({ env: {}, provider: 'claude', egress: { bound: true, source: 'pool', proxyUrl: 'http://127.0.0.1:17893' }, fs, aiHomeDir: home, lookupSync }), null);
    // 第三方中转：不继承官方提示。
    assert.equal(checkLaunchNetwork({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.com' }, provider: 'claude', egress: { bound: false }, fs, aiHomeDir: home, lookupSync }), null);
    // 用户规则放行大陆（规则优先于提示）。
    writeUpstreamPolicy(fs, home, denial.upstream.id, { rules: [{ effect: 'allow', match: { country: ['CN'] } }] });
    assert.equal(checkLaunchNetwork({ env: {}, provider: 'claude', egress: { bound: false }, fs, aiHomeDir: home, lookupSync }), null);
    assert.deepEqual(readEnvBaseUrls({ OPENAI_BASE_URL: 'https://x', FOO: 'https://y', BAR_BASE_URL: 'nope' }), ['https://x']);
    // aih 自己注入的协作地址（AIH_GATEWAY_BASE_URL → 本机网关）不是客户端上游，不能让守卫误以为「经网关」而跳过。
    assert.ok(checkLaunchNetwork({ env: { AIH_GATEWAY_BASE_URL: 'http://127.0.0.1:9527' }, provider: 'codex', egress: { bound: false }, fs, aiHomeDir: home, lookupSync }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('applyAccountEgressProxyEnv: guard is opt-in and throws account_egress_region_denied', () => {
  const home = tempHome();
  try {
    const base = { aiHomeDir: home, fs, accountRef: 'acct_x', lookupExitGeoSync: () => CN };
    assert.doesNotThrow(() => applyAccountEgressProxyEnv({}, 'claude', base));
    assert.throws(
      () => applyAccountEgressProxyEnv({}, 'claude', { ...base, networkGuard: true }),
      (error) => error.code === 'account_egress_region_denied' && /设置出口/.test(error.message)
    );
    assert.doesNotThrow(() => applyAccountEgressProxyEnv({}, 'claude', { ...base, networkGuard: true, isLogin: true }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('gateway guard: denied refs feed the Go hand-back set (Go has no network guard)', () => {
  const home = tempHome();
  const guard = require('../lib/runtime/egress-network-guard');
  try {
    fs.mkdirSync(path.join(home, 'run'), { recursive: true });
    fs.writeFileSync(path.join(home, 'run', guard.CACHE_FILE), JSON.stringify({ entries: { direct: CN } }));
    guard.resetEgressNetworkGuardCacheForTests();
    gatewayGuard.configureGatewayNetworkGuard({
      fs,
      aiHomeDir: home,
      getServerOptions: () => ({}),
      getPools: () => ({ claude: [{ provider: 'claude', accountRef: 'c1' }], cline: [{ provider: 'cline', accountRef: 'x1' }] })
    });
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, https_proxy: process.env.https_proxy, http_proxy: process.env.http_proxy };
    Object.keys(saved).forEach((key) => delete process.env[key]);
    try {
      assert.deepEqual([...gatewayGuard.listNetworkDeniedRefs()], ['c1']);
    } finally {
      Object.entries(saved).forEach(([key, value]) => { if (value !== undefined) process.env[key] = value; });
    }
  } finally {
    gatewayGuard.configureGatewayNetworkGuard(null);
    guard.resetEgressNetworkGuardCacheForTests();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('gateway guard: unconfigured = no-op; configured denies mainland direct exits, pool skipped', async () => {
  const home = tempHome();
  const guard = require('../lib/runtime/egress-network-guard');
  try {
    assert.equal(await gatewayGuard.checkGatewayNetwork({ accountRef: 'a', provider: 'claude', options: {} }), null);
    gatewayGuard.configureGatewayNetworkGuard({ fs, aiHomeDir: home, getAccount: () => ({ accountRef: 'a', provider: 'claude' }), getServerOptions: () => ({}) });
    // 预置缓存：直连在大陆。
    fs.mkdirSync(path.join(home, 'run'), { recursive: true });
    fs.writeFileSync(path.join(home, 'run', guard.CACHE_FILE), JSON.stringify({ entries: { direct: CN } }));
    guard.resetEgressNetworkGuardCacheForTests();
    const denial = await gatewayGuard.checkGatewayNetwork({ accountRef: 'a', provider: 'claude', options: { noProxy: '*' } });
    assert.equal(denial && denial.error, 'egress_region_denied');
    assert.equal(await gatewayGuard.checkGatewayNetwork({ accountRef: 'a', provider: 'claude', options: {}, egressSource: 'pool' }), null);
  } finally {
    gatewayGuard.configureGatewayNetworkGuard(null);
    guard.resetEgressNetworkGuardCacheForTests();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
