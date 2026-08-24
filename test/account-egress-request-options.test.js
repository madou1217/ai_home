'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAccountEgressRequestOptions
} = require('../lib/server/zcode-egress-service');

test('账号出口请求选项用所选账号的回环 sidecar 覆盖全局代理', async () => {
  assert.equal(typeof resolveAccountEgressRequestOptions, 'function');
  if (typeof resolveAccountEgressRequestOptions !== 'function') return;

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
        return {
          ok: true,
          proxyServer: '127.0.0.1:23101',
          source: 'group'
        };
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.options.proxyUrl, 'http://127.0.0.1:23101');
  assert.equal(result.options.noProxy, 'localhost,127.0.0.1,::1');
  assert.deepEqual(baseOptions, {
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'upstream.example'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.equal(calls[0].accountRef, 'acct_0123456789abcdef0123');
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
