'use strict';

// Xray / V2Ray 出站的 streamSettings → 节点的传输层与 TLS 字段（xray-config-parser 每个出站算一次，
// 交给各协议插件的 imports.xray）。新旧写法都认：network / method、tcp / raw、REALITY 的 publicKey / password。

const { protocolFieldError } = require('../protocol-fields');
const { alpnList, asObject, firstValue, headerHost, optionalString } = require('./clash-fields');

// Xray 的传输名 → 节点的传输。Xray 的 http 指 HTTP/2；节点的 http（HTTP/1.1 伪装）在 Xray 里是 tcp 加 http 头。
// kcp、quic、xhttp / splithttp 等节点表达不了，不在表里。
const NETWORKS = new Map([
  ['tcp', 'tcp'],
  ['raw', 'tcp'],
  ['ws', 'ws'],
  ['websocket', 'ws'],
  ['grpc', 'grpc'],
  ['h2', 'h2'],
  ['http', 'h2'],
  ['httpupgrade', 'httpupgrade']
]);

/** tcp 的 header.type = http 即 HTTP/1.1 伪装：路径与 Host 都是列表，取第一个。 */
function rawTransport(settings) {
  const header = asObject(settings.header);
  if (String(header.type || 'none').trim().toLowerCase() !== 'http') return { network: 'tcp' };
  const request = asObject(header.request);
  return { network: 'http', path: firstValue(request.path), host: headerHost(request.headers) };
}

function xrayTransport(stream) {
  const name = String(optionalString(stream.network) ?? optionalString(stream.method) ?? 'tcp').trim().toLowerCase() || 'tcp';
  const network = NETWORKS.get(name);
  if (!network) throw protocolFieldError(`unsupported_proxy_transport_${name}`);
  if (network === 'tcp') return rawTransport(asObject(stream.rawSettings ?? stream.tcpSettings));
  if (network === 'grpc') return { network, serviceName: optionalString(asObject(stream.grpcSettings).serviceName) };
  if (network === 'h2') {
    const h2 = asObject(stream.httpSettings ?? stream.h2Settings);
    return { network, path: optionalString(h2.path), host: firstValue(h2.host) };
  }
  // ws 与 httpupgrade：新版用 host，旧版写在 headers.Host。
  const options = asObject(network === 'ws' ? stream.wsSettings : stream.httpupgradeSettings);
  return { network, path: optionalString(options.path), host: optionalString(options.host) ?? headerHost(options.headers) };
}

function xrayTls(stream) {
  const security = String(stream.security || 'none').trim().toLowerCase() || 'none';
  if (security === 'none') return {};
  if (security === 'tls') {
    const tls = asObject(stream.tlsSettings);
    const alpn = alpnList(tls.alpn);
    return {
      tls: true,
      sni: optionalString(tls.serverName),
      alpn: Array.isArray(alpn) && alpn.length === 0 ? undefined : alpn,
      allowInsecure: tls.allowInsecure === true || undefined,
      fingerprint: optionalString(tls.fingerprint)
    };
  }
  if (security === 'reality') {
    const reality = asObject(stream.realitySettings);
    return {
      tls: true,
      security: 'reality',
      sni: optionalString(reality.serverName),
      publicKey: optionalString(reality.publicKey) ?? optionalString(reality.password),
      shortId: optionalString(reality.shortId),
      fingerprint: optionalString(reality.fingerprint)
    };
  }
  throw protocolFieldError(`unsupported_proxy_security_${security}`);
}

/** streamSettings → { network, path?, host?, serviceName?, tls?, sni?, alpn?, allowInsecure?, fingerprint?, REALITY 字段 }。 */
function xrayStream(streamSettings) {
  const stream = asObject(streamSettings);
  return { ...xrayTransport(stream), ...xrayTls(stream) };
}

/**
 * Shadowsocks / SOCKS5 / HTTP 节点没有传输层字段：只接受直连 TCP（allowTls 时还可以套 TLS，即 HTTPS），
 * 其余写法如实拒绝，不悄悄丢掉。
 */
function plainTcpStream(stream, { allowTls = false } = {}) {
  if (stream.network !== 'tcp') throw protocolFieldError(`unsupported_proxy_transport_${stream.network}`);
  if (stream.security === 'reality' || (stream.tls && !allowTls)) {
    throw protocolFieldError(`unsupported_proxy_security_${stream.security || 'tls'}`);
  }
  return stream;
}

module.exports = {
  plainTcpStream,
  xrayStream
};
