'use strict';

const { SUPPORTED_TRANSPORTS } = require('../../proxy-protocol-contract');

/**
 * sing-box 出站字段的通用拼装工具（供各协议插件的 compile['sing-box'] 复用）。
 * sing-box 目前作为 ZCode 出口的编译目标（lib/server/zcode-sing-box-*），尚未注册为代理池可运行内核。
 * 错误统一带 code，与 ZCode 配置编译器的错误码保持一致。
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
  if (network === 'ws') {
    const transport = { type: 'ws' };
    const path = String(node.path || '').trim();
    const host = String(node.host || '').trim();
    if (path) transport.path = path;
    if (host) transport.headers = { Host: host };
    return transport;
  }
  const transport = { type: 'grpc' };
  const serviceName = String(node.serviceName || '').trim();
  if (serviceName) transport.service_name = serviceName;
  return transport;
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
    tls.reality = {
      enabled: true,
      public_key: requiredString(node.publicKey, 'missing_required_proxy_field_publicKey'),
      short_id: requiredString(node.shortId, 'missing_required_proxy_field_shortId')
    };
  }
  const fingerprint = String(node.fingerprint || '').trim();
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
