'use strict';

// Egern 代理字段的通用拼装（供各协议插件的 compile.egern 复用）。Egern 的字段名用下划线，
// TLS 与传输层写法见 https://egernapp.com/docs/configuration/proxies/ ；表达不了的节点抛带 code 的错误。

const { protocolFieldError } = require('../../protocol-fields');

function requiredValue(node, field) {
  const value = String(node[field] ?? '').trim();
  if (!value) throw protocolFieldError(`missing_required_proxy_field_${field}`);
  return value;
}

function insecure(node) {
  return node.allowInsecure === true || node.insecure === true;
}

function isReality(node) {
  return String(node.security || '').trim().toLowerCase() === 'reality';
}

/** sni / skip_tls_verify（空值省略）。 */
function egernTls(node) {
  return { sni: node.sni || undefined, skip_tls_verify: insecure(node) || undefined };
}

function egernReality(node) {
  if (!isReality(node)) return undefined;
  return { public_key: requiredValue(node, 'publicKey'), short_id: node.shortId || undefined };
}

/**
 * VMess / VLESS 的 transport：明文 tcp 省略；tcp+TLS → tls（可带 reality）；ws / wss；grpc（只走 TLS）；
 * http1（HTTP/1.1 伪装）；http2。其余传输（httpupgrade 等）Egern 不支持。
 */
function egernTransport(node) {
  const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
  const tls = node.tls === true || isReality(node) || String(node.security || '').toLowerCase() === 'tls';
  const headers = node.host ? { Host: String(node.host) } : undefined;
  const reality = egernReality(node);
  if (network === 'tcp') return tls ? { tls: { ...egernTls(node), reality } } : undefined;
  if (network === 'ws') {
    return tls
      ? { wss: { path: node.path || '/', headers, ...egernTls(node) } }
      : { ws: { path: node.path || '/', headers } };
  }
  if (network === 'grpc' && tls) return { grpc: { service_name: node.serviceName || '', ...egernTls(node), reality } };
  if (network === 'h2') return { http2: { path: node.path || '/', headers, ...egernTls(node) } };
  if (network === 'http' && !tls) return { http1: { method: 'GET', path: node.path || '/', headers } };
  throw protocolFieldError(`unsupported_proxy_transport_${network}`);
}

module.exports = {
  egernReality,
  egernTls,
  egernTransport,
  insecure,
  requiredValue
};
