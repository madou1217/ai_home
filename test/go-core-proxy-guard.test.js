'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { explainGoProxyHandoff } = require('../lib/server/go-core-proxy-guard');
const { NODE_FALLBACK_REASONS, createNodeFallbackCounters } = require('../lib/server/go-core-node-fallback-counters');

test('no proxy configured never defers: Node and Go both connect directly', () => {
  assert.deepEqual(explainGoProxyHandoff({ proxyUrl: '', noProxy: '', env: {} }), { defer: false, reason: '' });
  assert.deepEqual(explainGoProxyHandoff({ env: { HTTPS_PROXY: 'http://p:1' } }), { defer: false, reason: '' });
});

test('a proxy Go can read from the standard env is forwarded, not deferred', () => {
  const env = { HTTPS_PROXY: 'http://proxy.local:8080' };
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://proxy.local:8080', env }),
    { defer: false, reason: '' }
  );
  // Go 的 httpproxy 同样接受小写变量。
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://proxy.local:8080', env: { https_proxy: 'http://proxy.local:8080' } }),
    { defer: false, reason: '' }
  );
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://proxy.local:8080', env: { HTTP_PROXY: 'http://proxy.local:8080' } }),
    { defer: false, reason: '' }
  );
});

test('a proxy only Node can see (server config / AIH_SERVER_PROXY_URL) is handed back to Node', () => {
  // 持久化 server config 或 --proxy-url：环境里没有任何标准变量。
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://proxy.local:8080', env: {} }),
    { defer: true, reason: 'proxy_not_go_visible' }
  );
  // AIH_SERVER_PROXY_URL 是 aih 私有名，Go 的 ProxyFromEnvironment 不读。
  assert.deepEqual(
    explainGoProxyHandoff({
      proxyUrl: 'http://proxy.local:8080',
      env: { AIH_SERVER_PROXY_URL: 'http://proxy.local:8080' }
    }),
    { defer: true, reason: 'proxy_not_go_visible' }
  );
  // 配置代理覆盖了标准变量：Node 用 config，Go 会用标准变量，两边分叉。
  assert.deepEqual(
    explainGoProxyHandoff({
      proxyUrl: 'http://config.local:8080',
      env: { HTTPS_PROXY: 'http://env.local:9090' }
    }),
    { defer: true, reason: 'proxy_not_go_visible' }
  );
});

test('a no-proxy bypass list Go cannot see also defers, so both sides bypass the same hosts', () => {
  const env = { HTTPS_PROXY: 'http://proxy.local:8080', NO_PROXY: 'localhost,127.0.0.1' };
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://proxy.local:8080', noProxy: 'localhost,127.0.0.1', env }),
    { defer: false, reason: '' }
  );
  // 绕过表来自 config（环境里没有 NO_PROXY）：Go 会绕过不同的 host。
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://proxy.local:8080', noProxy: 'internal.corp', env: { HTTPS_PROXY: 'http://proxy.local:8080' } }),
    { defer: true, reason: 'proxy_not_go_visible' }
  );
  assert.deepEqual(
    explainGoProxyHandoff({
      proxyUrl: 'http://proxy.local:8080',
      noProxy: 'internal.corp',
      env: { HTTPS_PROXY: 'http://proxy.local:8080', NO_PROXY: 'other.corp' }
    }),
    { defer: true, reason: 'proxy_not_go_visible' }
  );
});

test('the proxy hand-off reason is part of the /readyz breakdown contract', () => {
  assert.ok(NODE_FALLBACK_REASONS.includes('proxy_not_go_visible'));
  const snapshot = createNodeFallbackCounters().snapshot();
  assert.equal(snapshot.by_reason.proxy_not_go_visible, 0);
});
