'use strict';

const { SUPPORTED_TRANSPORTS } = require('../../proxy-protocol-contract');

/**
 * sing-box 出站字段的通用拼装工具（供各协议插件的 compile['sing-box'] 复用）。
 * 编译目标：订阅聚合的 sing-box 输出（AIH 自己不运行 sing-box）。
 * 错误统一带 code，订阅聚合据此把编不出的节点列为跳过项。
 */
function configError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredString(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw configError(code);
  return normalized;
}

function normalizeAlpn(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
}

function buildTransport(node) {
  const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
  if (!SUPPORTED_TRANSPORTS.has(network)) {
    throw configError(`unsupported_proxy_transport_${network}`);
  }
  if (network === 'tcp') return undefined;
  const path = String(node.path || '').trim();
  const host = String(node.host || '').trim();
  if (network === 'ws') {
    const transport = { type: 'ws' };
    if (path) transport.path = path;
    if (host) transport.headers = { Host: host };
    return transport;
  }
  if (network === 'httpupgrade') {
    const transport = { type: 'httpupgrade' };
    if (path) transport.path = path;
    if (host) transport.host = host;
    return transport;
  }
  if (network === 'h2' || network === 'http') {
    // sing-box 的 http 传输：带 TLS 时即 HTTP/2，不带时是 HTTP/1.1 伪装。
    const transport = { type: 'http' };
    if (host) transport.host = [host];
    if (path) transport.path = path;
    if (network === 'http') transport.method = 'GET';
    return transport;
  }
  if (network === 'grpc') {
    const transport = { type: 'grpc' };
    const serviceName = String(node.serviceName || '').trim();
    if (serviceName) transport.service_name = serviceName;
    return transport;
  }
  // 节点契约认识、sing-box 却没有的传输（例如 xhttp）：跳过节点，不能兜底成别的传输。
  throw configError(`unsupported_proxy_transport_${network}`);
}

function buildTls(node, options = {}) {
  const security = String(node.security || '').trim().toLowerCase();
  const realityEnabled = security === 'reality';
  const enabled = options.force === true
    || realityEnabled
    || node.tls === true
    || security === 'tls';
  if (!enabled) return undefined;

  const tls = { enabled: true };
  const serverName = String(node.sni || '').trim();
  if (serverName) tls.server_name = serverName;
  if (node.allowInsecure === true || node.insecure === true) tls.insecure = true;
  const alpn = normalizeAlpn(node.alpn);
  if (alpn?.length) tls.alpn = alpn;

  if (realityEnabled) {
    // short_id 可以为空（服务端允许空 short id 时），与 mihomo 的 reality-opts 一致。
    const shortId = String(node.shortId || '').trim();
    tls.reality = {
      enabled: true,
      public_key: requiredString(node.publicKey, 'missing_required_proxy_field_publicKey'),
      ...(shortId ? { short_id: shortId } : {})
    };
  }
  // reality 客户端必须启用 uTLS：没指定指纹时与 mihomo 一样默认 chrome。
  const fingerprint = String(node.fingerprint || '').trim() || (realityEnabled ? 'chrome' : '');
  if (fingerprint) {
    tls.utls = {
      enabled: true,
      fingerprint
    };
  }
  return tls;
}

function normalizePluginOptions(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('unsupported_shadowsocks_plugin_options');
  }
  return Object.entries(value)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(';');
}

module.exports = {
  buildTls,
  buildTransport,
  configError,
  normalizeAlpn,
  normalizePluginOptions,
  requiredString
};
