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

// Host 头是不是本机名字。反向代理转发到 127.0.0.1 时 TCP 对端也是回环，
// 只能靠 Host 区分「本机直连」和「外部域名经代理进来」。
function isLoopbackHostName(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return false;
  // 裸 IPv6 没有端口，先单独认；带方括号的按 ']' 截断再比较。
  if (host === '::1') return true;
  const withoutPort = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d+$/, '');
  return withoutPort === 'localhost'
    || withoutPort === '127.0.0.1'
    || withoutPort === '[::1]';
}

function isLoopbackHostHeader(req) {
  return isLoopbackHostName(req && req.headers && req.headers.host);
}

// 代理转发头：出现任何一个都说明请求不是客户端直连，而是经代理或另一台
// AIH Server 进来的。内部回调只接受本机直连，转发头与「本机」互斥。
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'x-aih-server-id'];

function hasForwardedHeaders(req) {
  const headers = (req && req.headers) || {};
  return FORWARDED_HEADERS.some((name) => String(headers[name] || '').trim() !== '');
}

// 内部回调的完整边界：TCP 对端是回环、Host 是回环名字、且没有任何转发头。
// 只检查对端地址会让「同机反向代理转发的公网请求」看起来像本机请求。
function isDirectLoopbackRequest(req) {
  return isLoopbackPeer(req) && isLoopbackHostHeader(req) && !hasForwardedHeaders(req);
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
  credentialsEqual,
  hasForwardedHeaders,
  isDirectLoopbackRequest,
  isLoopbackHostHeader,
  isLoopbackHostName,
  isLoopbackPeer,
  parseBearerCredential
};
