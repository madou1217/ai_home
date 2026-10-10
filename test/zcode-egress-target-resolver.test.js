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

test('proxyUrlIssue 只接受不带凭据与路径的 HTTP(S) 代理', () => {
  for (const value of ['http://127.0.0.1:6152', 'https://proxy.example:8443', '127.0.0.1:6152', 'proxy.example:8080']) {
    assert.equal(resolver.proxyUrlIssue(value), '', value);
  }
  for (const value of ['socks5://127.0.0.1:6153', 'socks4a://proxy.example:1080', 'ss://proxy.example:8388']) {
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
  assert.equal(resolver.normalizeProxyUrl('socks5://127.0.0.1:6153'), '');
  assert.equal(resolver.normalizeProxyUrl(''), '');
});

test('url 模式按 HTTP(S) 校验，socks 与带凭据地址 fail-closed', () => {
  const shorthand = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'proxy.example:8080' },
    platform: 'darwin'
  });
  assert.deepEqual(shorthand.target, { kind: 'proxy-url', proxyUrl: 'http://proxy.example:8080' });

  const socks = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'socks5://127.0.0.1:6153' },
    platform: 'darwin'
  });
  assert.equal(socks.ok, false);
  assert.equal(socks.error, 'proxy_scheme_unsupported');
  assert.equal(socks.target, null);

  const credentials = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'http://user:pass@proxy.example:8080' },
    platform: 'darwin'
  });
  assert.equal(credentials.error, 'invalid_proxy_url');
});

test('system 模式优先 HTTPS 再 HTTP，只有 SOCKS 时报 system_proxy_http_unavailable', () => {
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

  const socksOnly = resolver.resolveEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    detectSystemProxy: () => ({ enabled: true, probeStatus: 'available', socksProxy: 'socks5://127.0.0.1:1080' })
  });
  assert.equal(socksOnly.ok, false);
  assert.equal(socksOnly.error, 'system_proxy_http_unavailable');
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
