'use strict';

// Go 前门（持有公开端口）把真实客户端地址放在 X-AIH-Peer 转发给 Node。
// 这里锁定采信边界：只有 TCP 对端本身是 loopback 时才看这个头。

const test = require('node:test');
const assert = require('node:assert/strict');

const { peerAddress, isLoopbackPeer } = require('../lib/server/management-key-auth');
const { isLoopbackBootstrapIngress } = require('../lib/server/webui-auth-gate');

function req({ socketAddress = '127.0.0.1', headers = {}, method = 'GET', url = '/v0/webui/control-plane/bootstrap' } = {}) {
  return { method, url, headers, socket: { remoteAddress: socketAddress } };
}

test('loopback 前门来源采信 X-AIH-Peer', () => {
  assert.equal(peerAddress(req({ headers: { 'x-aih-peer': '203.0.113.9' } })), '203.0.113.9');
  assert.equal(isLoopbackPeer(req({ headers: { 'x-aih-peer': '203.0.113.9' } })), false);
  assert.equal(isLoopbackPeer(req({ headers: { 'x-aih-peer': '127.0.0.2' } })), true);
  assert.equal(isLoopbackPeer(req()), true);
});

test('非 loopback 来源不采信 X-AIH-Peer', () => {
  assert.equal(peerAddress(req({ socketAddress: '198.51.100.7', headers: { 'x-aih-peer': '127.0.0.1' } })), '198.51.100.7');
  assert.equal(isLoopbackPeer(req({ socketAddress: '198.51.100.7', headers: { 'x-aih-peer': '127.0.0.1' } })), false);
});

test('bootstrap：前门标记 + 本机 Host 放行，外网真实地址拒绝', () => {
  const allowed = req({ headers: { host: '127.0.0.1:9527', 'x-aih-peer': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(isLoopbackBootstrapIngress(allowed, new URL(allowed.url, 'http://localhost')), true);
  const denied = req({ headers: { host: '127.0.0.1:9527', 'x-aih-peer': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(isLoopbackBootstrapIngress(denied, new URL(denied.url, 'http://localhost')), false);
});

test('bootstrap：无前门标记时仍拒绝任何代理头（防普通反代绕过）', () => {
  const proxied = req({ headers: { host: '127.0.0.1:9527', 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(isLoopbackBootstrapIngress(proxied, new URL(proxied.url, 'http://localhost')), false);
});
