'use strict';

const crypto = require('node:crypto');

function parseBearerCredential(req, deps = {}) {
  const authorization = req && req.headers ? req.headers.authorization : '';
  if (typeof deps.parseAuthorizationBearer === 'function') {
    return String(deps.parseAuthorizationBearer(authorization) || '').trim();
  }
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
  return match && match[1] ? match[1].trim() : '';
}

function credentialsEqual(left, right) {
  const incoming = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return incoming.length === expected.length && crypto.timingSafeEqual(incoming, expected);
}

function rawPeerAddress(req) {
  return String((req && req.socket && req.socket.remoteAddress) || '').trim().toLowerCase();
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').replace(/^::ffff:/, '');
  return normalized === '::1' || normalized.startsWith('127.');
}

// 前门（Go）把真实客户端地址放在 X-AIH-Peer；只有 TCP 对端本身是 loopback 时才采信。
// Node 绑回环后，本机进程本来就有同样的能力，不会扩大攻击面；公网请求经过前门时
// 拿到的是真实外网地址。
function frontDoorPeer(req) {
  return String((req && req.headers && req.headers['x-aih-peer']) || '').trim().toLowerCase();
}

function peerAddress(req) {
  const raw = rawPeerAddress(req);
  if (!raw) return '';
  if (isLoopbackAddress(raw)) {
    const forwarded = frontDoorPeer(req);
    if (forwarded) return forwarded;
  }
  return raw;
}

function isLoopbackPeer(req) {
  return isLoopbackAddress(peerAddress(req));
}

function authorizeManagementKey({ req, credential, requiredManagementKey, deps = {} } = {}) {
  const expected = String(requiredManagementKey || '').trim();
  if (!expected) {
    return {
      ok: false,
      statusCode: 503,
      error: 'management_key_not_configured'
    };
  }
  const incoming = credential === undefined
    ? parseBearerCredential(req, deps)
    : String(credential || '').trim();
  if (!credentialsEqual(incoming, expected)) {
    return {
      ok: false,
      statusCode: 401,
      error: 'unauthorized_management'
    };
  }
  return {
    ok: true,
    via: 'management_key'
  };
}

function authorizeManagementKeyOrLoopback({ req, requiredManagementKey, deps = {} } = {}) {
  const expected = String(requiredManagementKey || '').trim();
  if (expected) {
    return authorizeManagementKey({ req, requiredManagementKey: expected, deps });
  }
  // 真实 HTTP 请求一定有 remoteAddress；缺失地址只用于进程内调用和单元测试。
  if (!peerAddress(req) || isLoopbackPeer(req)) {
    return { ok: true, via: 'loopback' };
  }
  return {
    ok: false,
    statusCode: 503,
    error: 'management_key_not_configured'
  };
}

module.exports = {
  authorizeManagementKey,
  authorizeManagementKeyOrLoopback,
  isLoopbackAddress,
  isLoopbackPeer,
  parseBearerCredential,
  peerAddress,
  rawPeerAddress
};
