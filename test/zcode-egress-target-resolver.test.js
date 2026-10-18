'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL
} = require('../lib/account/zcode-egress-binding-store');
const resolver = require('../lib/server/zcode-egress-resolver');

test('resolver 同步解析出口，只暴露外部代理目标', () => {
  assert.equal(typeof resolver.resolveEgressTarget, 'function');
  assert.equal(resolver.resolveZcodeEgressTarget, undefined);
  const result = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'http://127.0.0.1:6152' },
    platform: 'darwin'
  });
  assert.equal(typeof result.then, 'undefined');
  assert.deepEqual(result, {
    ok: true,
    source: EGRESS_MODE_URL,
    target: { kind: 'proxy-url', proxyUrl: 'http://127.0.0.1:6152' }
  });
});

test('proxyUrlIssue 接受 HTTP(S) 与 SOCKS5，拒绝 socks4/ss 与带凭据/路径的地址', () => {
  for (const value of [
    'http://127.0.0.1:6152',
    'https://proxy.example:8443',
    '127.0.0.1:6152',
    'proxy.example:8080',
    // socks5/socks5h 自 2026-10-17 起放行：网关侧由 socks5-connector 提供真正的
    // SOCKS5 隧道，曾经「静默直连」的成因消失。
    'socks5://127.0.0.1:6153',
    'socks5h://127.0.0.1:6153'
  ]) {
    assert.equal(resolver.proxyUrlIssue(value), '', value);
  }
  // socks4 无域名解析且已过时；`socks://` 语义在实现间不一致，不猜。
  for (const value of ['socks4://127.0.0.1:6153', 'socks4a://proxy.example:1080', 'ss://proxy.example:8388']) {
    assert.equal(resolver.proxyUrlIssue(value), 'proxy_scheme_unsupported', value);
  }
  for (const value of [
    '',
    'proxy.example',
    'http://user:pass@proxy.example:8080',
    'http://proxy.example:8080/path',
    'http://proxy.example:8080/?q=1',
    'not a url:80'
  ]) {
    assert.equal(resolver.proxyUrlIssue(value), 'invalid_proxy_url', value);
  }
});

test('normalizeProxyUrl 把简写补成 http://host:port，非法地址返回空串', () => {
  assert.equal(resolver.normalizeProxyUrl('127.0.0.1:6152'), 'http://127.0.0.1:6152');
  assert.equal(resolver.normalizeProxyUrl(' https://proxy.example:8443/ '), 'https://proxy.example:8443');
  assert.equal(resolver.normalizeProxyUrl('HTTP://Proxy.Example:80'), 'http://proxy.example');
  // socks5/socks5h 归一化时保留原 scheme（不能改写成 http://，那会变成另一种协议）。
  assert.equal(resolver.normalizeProxyUrl('socks5://127.0.0.1:6153'), 'socks5://127.0.0.1:6153');
  assert.equal(resolver.normalizeProxyUrl('socks5h://127.0.0.1:6153'), 'socks5h://127.0.0.1:6153');
  assert.equal(resolver.normalizeProxyUrl('socks5://127.0.0.1:6153', { provider: 'zcode' }), '');
  assert.equal(resolver.normalizeProxyUrl(''), '');
});

test('url 模式按消费方能力校验，socks4 与带凭据地址 fail-closed', () => {
  const shorthand = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'proxy.example:8080' },
    platform: 'darwin'
  });
  assert.deepEqual(shorthand.target, { kind: 'proxy-url', proxyUrl: 'http://proxy.example:8080' });

  const socks = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'socks5://127.0.0.1:6153' },
    platform: 'darwin'
  });
  assert.deepEqual(socks, {
    ok: true,
    source: EGRESS_MODE_URL,
    target: { kind: 'proxy-url', proxyUrl: 'socks5://127.0.0.1:6153' }
  });

  const credentials = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'http://user:pass@proxy.example:8080' },
    platform: 'darwin'
  });
  assert.equal(credentials.error, 'invalid_proxy_url');
});

// ZCode 的出口写进原生 setting.json 的 httpProxy 字段（socks 语义未经取证），因此
// url 模式的 scheme 白名单按 provider 收窄：保存时就明确报错，而不是写进一个会静默
// 失效的字段。其它 provider 的消费方（undici / Go / Chromium）都原生支持 socks5。
test('url 模式的 scheme 白名单按 provider 收窄：ZCode 只收 HTTP(S)', () => {
  const zcodeSocks = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'socks5://127.0.0.1:6153' },
    platform: 'darwin',
    provider: 'zcode'
  });
  assert.equal(zcodeSocks.ok, false);
  assert.equal(zcodeSocks.error, 'zcode_native_proxy_scheme_unsupported');

  const zcodeHttp = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'http://127.0.0.1:6152' },
    platform: 'darwin',
    provider: 'zcode'
  });
  assert.equal(zcodeHttp.ok, true);
  assert.equal(zcodeHttp.target.proxyUrl, 'http://127.0.0.1:6152');

  // 同一份绑定在别的 provider 上可用 —— 收窄是「消费方能力」，不是「地址非法」。
  const codexSocks = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'socks5://127.0.0.1:6153' },
    platform: 'darwin',
    provider: 'codex'
  });
  assert.equal(codexSocks.ok, true);
});

// opencode 是 Bun 二进制：Bun 静默忽略 socks 代理 env，socks5 写进 CLI 环境等于直连。
// 收窄声明在 opencode 描述符的 egress.proxySchemes，解析器不持有 provider 名单。
test('opencode 描述符声明只收 HTTP(S)：socks5 在入口被拒，applyAccountEgressProxyEnv 不会写出 socks', () => {
  for (const proxyUrl of ['socks5://127.0.0.1:6153', 'socks5h://127.0.0.1:6153']) {
    const result = resolver.resolveEgressTarget({
      binding: { mode: EGRESS_MODE_URL, proxyUrl },
      platform: 'darwin',
      provider: 'opencode'
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'zcode_native_proxy_scheme_unsupported');
  }
  assert.equal(resolver.proxyUrlIssue('socks5://127.0.0.1:6153', { provider: 'opencode' }), 'zcode_native_proxy_scheme_unsupported');
  assert.equal(resolver.proxyUrlIssue('http://127.0.0.1:6152', { provider: 'opencode' }), '');
  assert.deepEqual(resolver.allowedSchemesForProvider('opencode'), ['http:', 'https:']);
  assert.deepEqual(resolver.allowedSchemesForProvider('codex'), ['http:', 'https:', 'socks5:', 'socks5h:']);

  const { applyAccountEgressProxyEnv } = require('../lib/runtime/account-egress-proxy');
  assert.throws(
    () => applyAccountEgressProxyEnv({}, 'opencode', {
      accountRef: 'acct_opencode_1',
      accountEgress: { ok: true, source: 'url', proxyServer: 'socks5://127.0.0.1:6153' }
    }),
    (error) => error.code === 'account_egress_endpoint_invalid'
  );
});

test('egress 描述符契约：只能收窄到全集子集，且必须写 reason', () => {
  const { validateProviderDescriptor } = require('../lib/providers/contract');
  const build = (egress) => ({
    contractVersion: 1,
    id: 'demo',
    capabilities: { quota: { supported: false, reason: 'demo' }, egress }
  });
  const ok = validateProviderDescriptor(build({ proxySchemes: ['HTTP:', 'https:', 'http:'], reason: 'demo only' }));
  assert.deepEqual(ok.capabilities.egress.proxySchemes, ['http:', 'https:']);
  assert.throws(() => validateProviderDescriptor(build({ proxySchemes: [], reason: 'x' })), /egress_schemes_empty/);
  assert.throws(() => validateProviderDescriptor(build({ proxySchemes: ['socks4:'], reason: 'x' })), /egress_scheme_invalid/);
  assert.throws(() => validateProviderDescriptor(build({ proxySchemes: ['http:'] })), /egress_reason_missing/);
});

test('system 模式按 HTTPS > HTTP > SOCKS5 取用，只配 SOCKS 时也能用', () => {
  const calls = [];
  const preferred = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    detectSystemProxy: (options) => {
      calls.push(options.platform);
      return {
        enabled: true,
        probeStatus: 'available',
        httpsProxy: 'http://127.0.0.1:9443',
        httpProxy: 'http://127.0.0.1:9080',
        socksProxy: 'socks5://127.0.0.1:1080'
      };
    }
  });
  assert.deepEqual(calls, ['darwin']);
  assert.deepEqual(preferred, {
    ok: true,
    source: EGRESS_MODE_SYSTEM,
    target: { kind: 'proxy-url', proxyUrl: 'http://127.0.0.1:9443' }
  });

  const httpOnly = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    detectSystemProxy: () => ({ enabled: true, httpProxy: 'http://127.0.0.1:9080' })
  });
  assert.equal(httpOnly.target.proxyUrl, 'http://127.0.0.1:9080');

  // 只配了 SOCKS 的系统代理现在可直接复用（HTTP(S) 优先，SOCKS 兜底），
  // 用户不再需要为此手工另开一个 HTTP 端口。
  const socksOnly = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    detectSystemProxy: () => ({ enabled: true, probeStatus: 'available', socksProxy: 'socks5://127.0.0.1:1080' })
  });
  assert.equal(socksOnly.ok, true);
  assert.equal(socksOnly.target.proxyUrl, 'socks5://127.0.0.1:1080');

  // 但消费方承载不了 socks 时（ZCode 原生 httpProxy）仍要 fail-closed。
  const zcodeSocksOnly = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    provider: 'zcode',
    detectSystemProxy: () => ({ enabled: true, probeStatus: 'available', socksProxy: 'socks5://127.0.0.1:1080' })
  });
  assert.equal(zcodeSocksOnly.ok, false);
  assert.equal(zcodeSocksOnly.error, 'system_proxy_scheme_unavailable');
});

test('system 模式在系统代理未配置或探测失败时拒绝静默直连', () => {
  for (const status of [
    { enabled: false, probeStatus: 'unset' },
    { enabled: false, probeStatus: 'error' },
    null
  ]) {
    const result = resolver.resolveEgressTarget({
      binding: { mode: EGRESS_MODE_SYSTEM },
      platform: 'darwin',
      detectSystemProxy: () => status
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'system_proxy_unavailable');
  }

  const thrown = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    detectSystemProxy: () => {
      throw new Error('scutil timed out');
    }
  });
  assert.equal(thrown.error, 'system_proxy_unavailable');
  assert.equal(thrown.reason, 'scutil timed out');
});

test('tun 模式只接受已激活的外部 TUN，inactive 与 unknown 均 fail-closed', () => {
  for (const state of ['inactive', 'unknown']) {
    const result = resolver.resolveEgressTarget({
      binding: { mode: EGRESS_MODE_TUN },
      platform: 'darwin',
      detectTun: () => ({ state })
    });
    assert.equal(result.ok, false, state);
    assert.equal(result.error, state === 'unknown' ? 'tun_state_unknown' : 'tun_inactive');
  }

  const thrown = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_TUN },
    platform: 'darwin',
    detectTun: () => {
      throw new Error('netstat failed');
    }
  });
  assert.equal(thrown.error, 'tun_state_unknown');

  const active = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_TUN },
    platform: 'darwin',
    detectTun: () => ({ state: 'active', owner: 'clash-verge' })
  });
  assert.deepEqual(active, {
    ok: true,
    source: EGRESS_MODE_TUN,
    target: { kind: 'direct' },
    tun: { state: 'active', owner: 'clash-verge' }
  });
});

test('已下线的 node/group/pool 绑定、未绑定与未知模式都返回稳定错误', () => {
  assert.equal(resolver.resolveEgressTarget({ platform: 'darwin' }).error, 'not_bound');

  const retired = resolver.resolveEgressTarget({
    binding: { mode: 'group', retired: true, groupId: 'subscription:sub_a' },
    platform: 'darwin'
  });
  assert.equal(retired.ok, false);
  assert.equal(retired.error, 'account_egress_mode_retired');
  assert.equal(retired.mode, 'group');

  assert.equal(
    resolver.resolveEgressTarget({ binding: { mode: 'mystery' }, platform: 'darwin' }).error,
    'unknown_egress_mode'
  );
});

test('pool 绑定在池未就绪时 fail-closed 并惰性拉起池；就绪后解析到池地址', () => {
  let ensured = 0;
  const notReady = resolver.resolveEgressTarget({
    binding: { mode: 'pool' },
    platform: 'darwin',
    egressPoolRegistry: {
      currentEgressPoolProxyUrl: () => '',
      ensureEgressPoolStarted: () => { ensured += 1; return true; }
    }
  });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, 'egress_pool_not_ready');
  assert.equal(ensured, 1);

  const ready = resolver.resolveEgressTarget({
    binding: { mode: 'pool' },
    platform: 'darwin',
    egressPoolRegistry: {
      currentEgressPoolProxyUrl: () => 'http://127.0.0.1:17890',
      ensureEgressPoolStarted: () => { ensured += 1; return true; }
    }
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.target.proxyUrl, 'http://127.0.0.1:17890');
  assert.equal(ensured, 1);
});

test('非 macOS 平台不支持账号出口，且不触发探测', () => {
  const result = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'linux',
    detectSystemProxy: () => {
      throw new Error('must not probe');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_supported');
  assert.equal(result.platform, 'linux');
});

test('探测缓存只在显式开启时生效，按探测函数隔离并在 15s 后过期', () => {
  resolver.clearEgressDetectionCache();
  let now = 1_000;
  let calls = 0;
  const detectTun = () => {
    calls += 1;
    return { state: 'active' };
  };
  const resolveTun = (extra = {}) => resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_TUN },
    platform: 'darwin',
    detectTun,
    now: () => now,
    ...extra
  });

  resolveTun();
  resolveTun();
  assert.equal(calls, 2, '默认不缓存');

  resolveTun({ useDetectionCache: true });
  resolveTun({ useDetectionCache: true });
  assert.equal(calls, 3, '显式开启后复用');

  now += resolver.DETECTION_CACHE_TTL_MS;
  resolveTun({ useDetectionCache: true });
  assert.equal(calls, 4, '过期后重新探测');

  let otherCalls = 0;
  resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_TUN },
    platform: 'darwin',
    detectTun: () => {
      otherCalls += 1;
      return { state: 'inactive' };
    },
    now: () => now,
    useDetectionCache: true
  });
  assert.equal(otherCalls, 1, '其他探测函数不共享缓存');

  resolver.clearEgressDetectionCache();
  resolveTun({ useDetectionCache: true });
  assert.equal(calls, 5, '清空后重新探测');
});

test('出口解析器与节点存储不依赖任何代理内核', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const resolverSource = fs.readFileSync(path.join(root, 'lib/server/zcode-egress-resolver.js'), 'utf8');
  const storeSource = fs.readFileSync(
    path.join(root, 'lib/cli/services/toolkit/proxy-pool/proxy-node-store.js'),
    'utf8'
  );

  assert.doesNotMatch(resolverSource, /mihomo|sing-box|ProxyPoolService|startDedicatedPort|lease/i);
  assert.doesNotMatch(storeSource, /cores\/mihomo|mihomo-config-compiler|zcode-sing-box/);
});
