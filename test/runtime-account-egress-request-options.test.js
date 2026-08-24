'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRuntimeAccountEgressRequestOptions
} = require('../lib/server/runtime-account-egress-request-options');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

test('子进程账号出口适配器只读取已就绪 runtime，并返回固定回环代理', async () => {
  const calls = [];
  const result = await resolveRuntimeAccountEgressRequestOptions({
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    aiHomeDir: '/tmp/aih-runtime-egress',
    options: { proxyUrl: 'http://global-proxy.example:7890' }
  }, {
    resolveAccountEgressRuntimeProxy(input) {
      calls.push(input);
      return { bound: true, proxyServer: '127.0.0.1:23109' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.options.proxyUrl, 'http://127.0.0.1:23109');
  assert.equal(result.options.noProxy, 'localhost,127.0.0.1,::1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountRef, ACCOUNT_REF);
});

test('未绑定子进程账号保持既有直连策略', async () => {
  const options = { marker: 'preserved' };
  const result = await resolveRuntimeAccountEgressRequestOptions({
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    aiHomeDir: '/tmp/aih-runtime-egress',
    options
  }, {
    resolveAccountEgressRuntimeProxy: () => ({ bound: false, proxyServer: '' })
  });

  assert.deepEqual(result, { ok: true, bound: false, options });
});

test('绑定 runtime 不可用时子进程 fail-closed，不返回可直连 options', async () => {
  const result = await resolveRuntimeAccountEgressRequestOptions({
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    aiHomeDir: '/tmp/aih-runtime-egress',
    options: { marker: 'must-not-leak' }
  }, {
    resolveAccountEgressRuntimeProxy() {
      const error = new Error('account_egress_runtime_not_ready');
      error.code = 'account_egress_runtime_not_ready';
      throw error;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.bound, true);
  assert.equal(result.error, 'account_egress_unavailable');
  assert.equal(result.egressError, 'account_egress_runtime_not_ready');
  assert.equal(Object.hasOwn(result, 'options'), false);
});

test('有账号但缺失 AIH_HOME 时 fail-closed，避免错误宿主上下文下直连', async () => {
  const result = await resolveRuntimeAccountEgressRequestOptions({
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    options: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.bound, true);
  assert.equal(result.egressError, 'account_egress_context_missing');
});
