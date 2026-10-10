'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyProxyEnvironment,
  buildGoProxyEnvironment,
  explainGoProxyHandoff
} = require('../lib/server/go-core-proxy-guard');
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

test('a socks proxy in config means Node connects directly, so Go must carry no proxy either', () => {
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'socks5://127.0.0.1:6153', env: {} }),
    { defer: false, reason: '' }
  );
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'socks5://127.0.0.1:6153', env: { HTTPS_PROXY: 'http://env.local:9090' } }),
    { defer: true, reason: 'proxy_not_go_visible' }
  );
});

test('the Go child environment carries the proxy Node uses from server config', () => {
  const hostEnv = { PATH: '/usr/bin', HTTPS_PROXY: 'http://host.local:1', NO_PROXY: 'host.corp' };
  const overrides = buildGoProxyEnvironment({
    proxyUrl: 'http://127.0.0.1:6152',
    noProxy: 'localhost,127.0.0.1,0.0.0.0',
    env: hostEnv
  });
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    assert.equal(overrides[name], 'http://127.0.0.1:6152', name);
  }
  assert.equal(overrides.NO_PROXY, 'localhost,127.0.0.1,0.0.0.0');
  assert.equal(overrides.no_proxy, 'localhost,127.0.0.1,0.0.0.0');

  const goEnv = applyProxyEnvironment(hostEnv, overrides);
  assert.equal(goEnv.PATH, '/usr/bin');
  assert.equal(goEnv.HTTPS_PROXY, 'http://127.0.0.1:6152');
  assert.equal(hostEnv.HTTPS_PROXY, 'http://host.local:1', '宿主环境不被修改');
  assert.deepEqual(
    explainGoProxyHandoff({ proxyUrl: 'http://127.0.0.1:6152', noProxy: 'localhost,127.0.0.1,0.0.0.0', env: goEnv }),
    { defer: false, reason: '' },
    '按配置启动的 Go 不再被交还'
  );
});

test('the Go child environment follows Node bypass and direct-connect rules', () => {
  // 配置没写绕过表：Node 回落到宿主 NO_PROXY，Go 拿到同一份。
  assert.equal(
    buildGoProxyEnvironment({ proxyUrl: 'http://p:1', env: { NO_PROXY: 'internal.corp' } }).NO_PROXY,
    'internal.corp'
  );
  // 完全没有绕过表：删除继承变量，两边都不绕过。
  assert.equal(buildGoProxyEnvironment({ proxyUrl: 'http://p:1', env: {} }).NO_PROXY, null);
  // 非 http(s) 显式代理：Node 直连，Go 的代理变量全部删除。
  const socks = buildGoProxyEnvironment({ proxyUrl: 'socks5://127.0.0.1:6153', env: { HTTPS_PROXY: 'http://x:1' } });
  assert.equal(socks.HTTPS_PROXY, null);
  assert.equal(socks.NO_PROXY, null);
  assert.equal('HTTPS_PROXY' in applyProxyEnvironment({ HTTPS_PROXY: 'http://x:1' }, socks), false);
  // 没有显式代理：不覆盖，Node 与 Go 读同一份宿主环境。
  assert.deepEqual(buildGoProxyEnvironment({ proxyUrl: '', env: { HTTPS_PROXY: 'http://x:1' } }), {});
  assert.equal(
    buildGoProxyEnvironment({ env: { AIH_SERVER_PROXY_URL: 'http://aih.local:2' } }).HTTPS_PROXY,
    'http://aih.local:2'
  );
});

test('the proxy hand-off reason is part of the /readyz breakdown contract', () => {
  assert.ok(NODE_FALLBACK_REASONS.includes('proxy_not_go_visible'));
  const snapshot = createNodeFallbackCounters().snapshot();
  assert.equal(snapshot.by_reason.proxy_not_go_visible, 0);
});
