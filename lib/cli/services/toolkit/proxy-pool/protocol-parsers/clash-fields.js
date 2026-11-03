'use strict';

// Clash / mihomo 代理条目 → 节点字段的公共映射（供各协议插件的 imports.clash 复用）。
// 只读取认识的键，其余一律忽略：机场订阅常带 udp / tfo / smux 等开关，不影响出站身份。

function optionalString(value) {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function transportError(network) {
  const error = new Error(`unsupported_proxy_transport_${network}`);
  error.code = error.message;
  return error;
}

function enabled(value) {
  return value === true || /^(?:true|1|yes|tls)$/i.test(String(value ?? '').trim());
}

function numericRate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstValue(value) {
  return optionalString(Array.isArray(value) ? value[0] : value);
}

function headerHost(headers) {
  const entry = Object.entries(asObject(headers)).find(([key]) => key.toLowerCase() === 'host');
  return entry ? firstValue(entry[1]) : undefined;
}

function alpnList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return optionalString(value);
}

/** TLS 相关字段；forceTls 用于天然走 TLS 的协议（trojan、hysteria2 等）。 */
function clashTls(proxy, options = {}) {
  return {
    tls: options.forceTls === true ? true : enabled(proxy.tls),
    sni: optionalString(proxy.servername ?? proxy.sni),
    alpn: alpnList(proxy.alpn),
    allowInsecure: enabled(proxy['skip-cert-verify']) || undefined,
    fingerprint: optionalString(proxy['client-fingerprint'])
  };
}

/**
 * 传输层字段：ws（含 v2ray-http-upgrade）/ grpc / h2 / http / xhttp。
 * xhttp 只有 VLESS 能用，所以默认拒绝，由支持的插件显式打开（options.xhttp）。
 */
function clashTransport(proxy, options = {}) {
  const network = String(proxy.network || 'tcp').trim().toLowerCase() || 'tcp';
  if (network === 'xhttp' && options.xhttp !== true) throw transportError(network);
  const fields = { network };
  if (network === 'ws') {
    const ws = asObject(proxy['ws-opts']);
    fields.path = optionalString(ws.path);
    fields.host = headerHost(ws.headers);
    if (ws['v2ray-http-upgrade'] === true) fields.network = 'httpupgrade';
  } else if (network === 'grpc') {
    fields.serviceName = optionalString(asObject(proxy['grpc-opts'])['grpc-service-name']);
  } else if (network === 'h2') {
    const h2 = asObject(proxy['h2-opts']);
    fields.path = optionalString(h2.path);
    fields.host = firstValue(h2.host);
  } else if (network === 'http') {
    const http = asObject(proxy['http-opts']);
    fields.path = firstValue(http.path);
    fields.host = headerHost(http.headers);
  } else if (network === 'xhttp') {
    const xhttp = asObject(proxy['xhttp-opts']);
    fields.path = optionalString(xhttp.path);
    fields.host = optionalString(xhttp.host);
    fields.mode = optionalString(xhttp.mode);
  }
  return fields;
}

module.exports = {
  alpnList,
  asObject,
  clashTls,
  clashTransport,
  enabled,
  firstValue,
  headerHost,
  numericRate,
  optionalString,
  transportError
};
