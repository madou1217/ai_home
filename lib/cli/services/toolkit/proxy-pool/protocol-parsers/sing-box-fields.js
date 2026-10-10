'use strict';

// sing-box outbound → 节点字段的公共映射（供各协议插件的 imports['sing-box'] 复用），
// 与 cores/sing-box/outbound-fields 的编译方向对称。

const { asObject, firstValue, headerHost, optionalString } = require('./clash-fields');

function singBoxTls(outbound, options = {}) {
  const tls = asObject(outbound.tls);
  const reality = asObject(tls.reality);
  const utls = asObject(tls.utls);
  const fields = {
    tls: options.forceTls === true || tls.enabled === true || reality.enabled === true || undefined,
    sni: optionalString(tls.server_name),
    alpn: Array.isArray(tls.alpn) ? tls.alpn.map(String) : optionalString(tls.alpn),
    allowInsecure: tls.insecure === true || undefined,
    fingerprint: utls.enabled === true ? optionalString(utls.fingerprint) : undefined
  };
  if (reality.enabled === true) {
    Object.assign(fields, {
      security: 'reality',
      publicKey: optionalString(reality.public_key),
      shortId: optionalString(reality.short_id)
    });
  }
  return fields;
}

function singBoxTransport(outbound) {
  const transport = asObject(outbound.transport);
  const type = String(transport.type || '').trim().toLowerCase();
  if (!type) return { network: 'tcp' };
  if (type === 'ws') {
    return { network: 'ws', path: optionalString(transport.path), host: headerHost(transport.headers) };
  }
  if (type === 'grpc') return { network: 'grpc', serviceName: optionalString(transport.service_name) };
  if (type === 'httpupgrade') {
    return { network: 'httpupgrade', path: optionalString(transport.path), host: optionalString(transport.host) };
  }
  if (type === 'http') {
    // 带 TLS 的 http 传输即 HTTP/2，否则是 HTTP/1.1 伪装（与编译方向一致）。
    return {
      network: asObject(outbound.tls).enabled === true ? 'h2' : 'http',
      path: optionalString(transport.path),
      host: firstValue(transport.host)
    };
  }
  // quic 等暂不支持的传输原样带出，由节点库按传输层白名单拒绝并记录原因。
  return { network: type };
}

module.exports = {
  singBoxTls,
  singBoxTransport
};
