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

function peerAddress(req) {
  return String((req && req.socket && req.socket.remoteAddress) || '').trim().toLowerCase();
}

function isLoopbackPeer(req) {
  const address = peerAddress(req);
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '::1' || normalized.startsWith('127.');
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
  isLoopbackPeer,
  parseBearerCredential
};
