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

test('出口给出 socks 等非 HTTP(S) 地址时 fail closed，避免请求路径静默直连', async () => {
  const result = await resolveAccountEgressRequestOptions({
    fs: {},
    aiHomeDir: '/tmp/aih-account-egress-options',
    provider: 'codex',
    accountRef: 'acct_4123456789abcdef0123',
    options: {},
    deps: { resolveAccountEgress: async () => ({ ok: true, source: 'url', proxyServer: 'socks5://127.0.0.1:6153' }) }
  });

  assert.equal(result.ok, false);
  assert.equal(result.egressError, 'account_egress_endpoint_invalid');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'options'), false);
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
