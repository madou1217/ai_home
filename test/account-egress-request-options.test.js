'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAccountEgressRequestOptions
} = require('../lib/server/zcode-egress-service');

test('账号出口请求选项用所选账号的外部代理覆盖全局代理', async () => {
  const baseOptions = {
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'upstream.example'
  };
  const calls = [];
  const result = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'claude',
    accountRef: 'acct_0123456789abcdef0123',
    options: baseOptions,
    deps: {
      async resolveAccountEgress(input) {
        calls.push(input);
        return { ok: true, proxyServer: '127.0.0.1:6152', source: 'url' };
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.options.proxyUrl, 'http://127.0.0.1:6152');
  assert.equal(result.options.noProxy, 'localhost,127.0.0.1,::1');
  assert.deepEqual(baseOptions, {
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'upstream.example'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.equal(calls[0].accountRef, 'acct_0123456789abcdef0123');
});

test('TUN 出口的请求选项清空代理并全量 no-proxy，不会落到服务端全局上游代理', async () => {
  const result = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'codex',
    accountRef: 'acct_3123456789abcdef0123',
    options: { proxyUrl: 'http://global-proxy.example:7890' },
    deps: { resolveAccountEgress: async () => ({ ok: true, source: 'tun', proxyServer: '', direct: true }) }
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.options.proxyUrl, '');
  assert.equal(result.options.noProxy, '*');
});

test('出口给出 socks5 地址时正常下发；socks4 等不受支持的 scheme fail closed', async () => {
  // socks5 现在由网关侧的 socks5-connector 建隧道，因此必须真的下发（而不是被丢弃后
  // 静默直连 —— 那正是过去一刀切拒绝 socks 的原因）。
  const socks5 = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'codex',
    accountRef: 'acct_4123456789abcdef0123',
    options: {},
    deps: { resolveAccountEgress: async () => ({ ok: true, source: 'url', proxyServer: 'socks5://127.0.0.1:6153' }) }
  });
  assert.equal(socks5.ok, true);
  assert.equal(socks5.options.proxyUrl, 'socks5://127.0.0.1:6153');

  const socks4 = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'codex',
    accountRef: 'acct_4123456789abcdef0123',
    options: {},
    deps: { resolveAccountEgress: async () => ({ ok: true, source: 'url', proxyServer: 'socks4://127.0.0.1:6153' }) }
  });
  assert.equal(socks4.ok, false);
  assert.equal(socks4.egressError, 'account_egress_endpoint_invalid');
  assert.equal(Object.prototype.hasOwnProperty.call(socks4, 'options'), false);
});

// ZCode 的原生 httpProxy 字段只认 HTTP(S)：同一份 socks 绑定在 codex 上可用、在 zcode 上
// 必须在请求路径也 fail-closed，否则会出现「保存时被拒、请求时却放行」的分裂。
test('scheme 白名单按 provider 收窄：ZCode 的 socks 出口在请求路径同样 fail closed', async () => {
  const zcode = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'zcode',
    accountRef: 'acct_4123456789abcdef0123',
    options: {},
    deps: { resolveAccountEgress: async () => ({ ok: true, source: 'url', proxyServer: 'socks5://127.0.0.1:6153' }) }
  });
  assert.equal(zcode.ok, false);
  assert.equal(zcode.egressError, 'account_egress_endpoint_invalid');
});

test('未绑定账号保留 Gateway 既有全局代理策略', async () => {
  assert.equal(typeof resolveAccountEgressRequestOptions, 'function');
  if (typeof resolveAccountEgressRequestOptions !== 'function') return;

  const baseOptions = {
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'localhost'
  };
  const result = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'gemini',
    accountRef: 'acct_1123456789abcdef0123',
    options: baseOptions,
    deps: { resolveAccountEgress: async () => null }
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, false);
  assert.deepEqual(result.options, baseOptions);
});

test('已绑定账号出口不可用时 fail closed，不回退全局代理或直连', async () => {
  assert.equal(typeof resolveAccountEgressRequestOptions, 'function');
  if (typeof resolveAccountEgressRequestOptions !== 'function') return;

  const result = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'codex',
    accountRef: 'acct_2123456789abcdef0123',
    options: { proxyUrl: 'http://global-proxy.example:7890' },
    deps: {
      resolveAccountEgress: async () => ({
        ok: false,
        error: 'proxy_unreachable',
        reason: 'connection refused'
      })
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_egress_unavailable');
  assert.equal(result.egressError, 'proxy_unreachable');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'options'), false);
});

// ── 出口解析不得依赖调用方层层透传 aiHomeDir ────────────────────────────────
// 真实事故（2026-10-17）：出口解析挂在 v1-router → protocol-fallback-bridge →
// upstream-endpoints → attempt 的多层 deps 透传上，任何一层漏传 aiHomeDir 都会让
// 账号级出口静默失效、悄悄回落到全局代理 —— 表现为「账号明明绑了出口，请求却
// 走全局代理」，而且没有任何报错。所以漏传时必须按默认位置解析，不能当作无绑定。

test('漏传 aiHomeDir 时按默认位置解析，而不是判定为无绑定', async () => {
  const resolved = [];
  const result = await resolveAccountEgressRequestOptions({
    fs: {},
    provider: 'opencode',
    accountRef: 'acct_2123456789abcdef0123',
    options: { proxyUrl: 'http://global-proxy.example:7890' },
    deps: {
      resolveAccountEgress: async (input) => {
        resolved.push(input.aiHomeDir);
        return { ok: true, source: 'url', proxyServer: 'http://127.0.0.1:17890' };
      }
    }
  });

  // 关键断言：解析确实发生了（bound 为真），且带上了可用的 aiHomeDir。
  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(resolved.length, 1);
  assert.ok(resolved[0] && resolved[0].length > 0, 'aiHomeDir 必须被解析出来而不是空串');
});

test('显式 aiHomeDir 优先于默认位置', async () => {
  const resolved = [];
  await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/explicit-ai-home',
    provider: 'opencode',
    accountRef: 'acct_2123456789abcdef0123',
    options: {},
    deps: {
      resolveAccountEgress: async (input) => {
        resolved.push(input.aiHomeDir);
        return { ok: true, source: 'url', proxyServer: 'http://127.0.0.1:17890' };
      }
    }
  });
  assert.equal(resolved[0], '/tmp/explicit-ai-home');
});

test('完全没有存储上下文（无 fs、无 aiHomeDir）时不读默认数据目录，保持既有网络策略', async () => {
  const baseOptions = { proxyUrl: 'http://global-proxy.example:7890' };
  let resolverCalls = 0;
  const result = await resolveAccountEgressRequestOptions({
    provider: 'opencode',
    accountRef: 'acct_3123456789abcdef0123',
    options: baseOptions,
    deps: {
      resolveAccountEgress: async () => {
        resolverCalls += 1;
        return { ok: true, source: 'url', proxyServer: 'http://127.0.0.1:17890' };
      }
    }
  });
  // 纯协议调用/嵌入实例：默认数据目录属于别的实例（测试里就是宿主真实 ~/.ai_home）。
  assert.equal(resolverCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.bound, false);
  assert.deepEqual(result.options, baseOptions);
});
