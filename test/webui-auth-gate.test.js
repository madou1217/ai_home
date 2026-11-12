'use strict';

// WebUI 鉴权门的窄口：本机页面引导（control-plane/bootstrap）。
//
// 这条入口不带 Management Key，因此必须逐条锁死：方法、路径、loopback 对端、
// loopback Host、以及任何转发头。任何一个条件放宽都等于把 Key 交给局域网。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authorizeWebUiRequest,
  isLoopbackBootstrapIngress
} = require('../lib/server/webui-auth-gate');

function req(overrides = {}) {
  return {
    method: 'GET',
    url: '/v0/webui/control-plane/bootstrap',
    headers: { host: '127.0.0.1:9527' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides
  };
}

function url(pathname = '/v0/webui/control-plane/bootstrap') {
  return new URL('http://127.0.0.1:9527' + pathname);
}

test('loopback 页面 + loopback Host：引导入口放行', () => {
  assert.equal(isLoopbackBootstrapIngress(req(), url()), true);
  const gate = authorizeWebUiRequest({ req: req(), url: url(), requiredManagementKey: 'k' });
  assert.equal(gate.ok, true);
  assert.equal(gate.via, 'loopback_bootstrap');
});

test('localhost / [::1] 主机名同样放行', () => {
  for (const host of ['localhost:9527', 'localhost', '[::1]:9527', '::1']) {
    assert.equal(isLoopbackBootstrapIngress(req({ headers: { host } }), url()), true, host);
  }
});

test('非 loopback 对端拒绝（局域网客户端拿不到 Key）', () => {
  const remote = req({ socket: { remoteAddress: '192.168.31.57' } });
  assert.equal(isLoopbackBootstrapIngress(remote, url()), false);
  const gate = authorizeWebUiRequest({ req: remote, url: url(), requiredManagementKey: 'k' });
  assert.equal(gate.ok, false);
  assert.equal(gate.statusCode, 401);
});

test('loopback 对端但 Host 是外部域名拒绝（反向代理场景）', () => {
  const proxied = req({ headers: { host: 'gateway.example.com' } });
  assert.equal(isLoopbackBootstrapIngress(proxied, url()), false);
  assert.equal(authorizeWebUiRequest({ req: proxied, url: url(), requiredManagementKey: 'k' }).ok, false);
});

test('带转发头一律拒绝', () => {
  for (const headers of [
    { host: '127.0.0.1:9527', 'x-forwarded-for': '203.0.113.9' },
    { host: '127.0.0.1:9527', 'x-real-ip': '203.0.113.9' },
    { host: '127.0.0.1:9527', forwarded: 'for=203.0.113.9' }
  ]) {
    assert.equal(isLoopbackBootstrapIngress(req({ headers }), url()), false);
  }
});

test('只允许 GET 与固定路径', () => {
  assert.equal(isLoopbackBootstrapIngress(req({ method: 'POST' }), url()), false);
  assert.equal(isLoopbackBootstrapIngress(req(), url('/v0/webui/control-plane/profiles')), false);
  assert.equal(isLoopbackBootstrapIngress(req(), url('/v0/webui/accounts')), false);
});

test('同一路径带 Key 的正常请求不受影响', () => {
  const withKey = req({ headers: { host: 'gateway.example.com', authorization: 'Bearer k' } });
  const gate = authorizeWebUiRequest({ req: withKey, url: url(), requiredManagementKey: 'k' });
  assert.equal(gate.ok, true);
  assert.equal(gate.via, 'management_key');
});
