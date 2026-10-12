'use strict';

// Egern 代理条目 → 节点字段的公共映射（供各协议插件的 imports.egern 复用），与 cores/egern/proxy-fields
// 的编译方向对称。Egern 的字段名用下划线；TLS 是否开启由条目类型决定（tls / wss / grpc / http2 / https …）。

const { protocolFieldError } = require('../protocol-fields');
const { asObject, headerHost, optionalString } = require('./clash-fields');
const { surgeObfsFields } = require('./surge-fields');

/** sni / skip_tls_verify → 节点的 sni / allowInsecure。 */
function egernTlsFields(entry) {
  return { sni: optionalString(entry.sni), allowInsecure: entry.skip_tls_verify === true || undefined };
}

/** reality: { public_key, short_id } → 节点的 REALITY 字段（REALITY 本身就是 TLS）。 */
function egernRealityFields(reality) {
  const options = asObject(reality);
  if (!Object.keys(options).length) return {};
  return {
    tls: true,
    security: 'reality',
    publicKey: optionalString(options.public_key),
    shortId: optionalString(options.short_id)
  };
}

/**
 * VMess / VLESS 的 transport（单键映射）→ 节点的传输层与 TLS 字段，egernTransport 的逆映射：
 * 省略即明文 tcp；tls（可带 reality）；ws / wss；grpc（只走 TLS）；http1（HTTP/1.1 伪装）；http2。
 */
function egernTransportFields(transport) {
  const [type, value] = Object.entries(asObject(transport))[0] || [];
  if (!type) return { network: 'tcp' };
  const options = asObject(value);
  const path = optionalString(options.path);
  const host = headerHost(options.headers);
  const tls = { tls: true, ...egernTlsFields(options) };
  if (type === 'tls') return { network: 'tcp', ...tls, ...egernRealityFields(options.reality) };
  if (type === 'ws') return { network: 'ws', path, host };
  if (type === 'wss') return { network: 'ws', path, host, ...tls };
  if (type === 'grpc') {
    return { network: 'grpc', serviceName: optionalString(options.service_name), ...tls, ...egernRealityFields(options.reality) };
  }
  if (type === 'http1') return { network: 'http', path, host };
  if (type === 'http2') return { network: 'h2', path, host, ...tls };
  throw protocolFieldError(`unsupported_proxy_transport_${type}`);
}

/** Shadowsocks 的 obfs / obfs_host / obfs_uri → simple-obfs 插件字段（与 Surge 的写法同一表示）。 */
function egernObfsFields(entry) {
  return surgeObfsFields({ obfs: entry.obfs, 'obfs-host': entry.obfs_host, 'obfs-uri': entry.obfs_uri });
}

module.exports = {
  egernObfsFields,
  egernRealityFields,
  egernTlsFields,
  egernTransportFields
};
