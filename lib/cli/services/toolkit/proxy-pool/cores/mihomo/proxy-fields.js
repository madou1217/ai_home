'use strict';

const { SUPPORTED_TRANSPORTS } = require('../../proxy-protocol-contract');

/**
 * mihomo 出站字段的通用拼装工具（供各协议插件的 compile.mihomo 复用）。
 */
function requiredString(node, field) {
  if (typeof node[field] !== 'string' || node[field].length === 0) {
    throw new Error(`missing_required_proxy_field_${field}`);
  }
  return node[field];
}

function normalizePluginOptions(value) {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('unsupported_shadowsocks_plugin_option');
      }
      if (!['string', 'number', 'boolean'].includes(typeof item)) {
        throw new Error(`unsupported_shadowsocks_plugin_option_${key}`);
      }
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new Error(`unsupported_shadowsocks_plugin_option_${key}`);
      }
      normalized[key] = item;
    }
    return normalized;
  }
  if (typeof value !== 'string') throw new Error('unsupported_shadowsocks_plugin_options');
  const normalized = {};
  for (const token of value.split(';').map((item) => item.trim()).filter(Boolean)) {
    const separator = token.indexOf('=');
    const key = separator === -1 ? token : token.slice(0, separator);
    if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error('unsupported_shadowsocks_plugin_option');
    }
    if (separator === -1) normalized[key] = true;
    else normalized[key] = token.slice(separator + 1);
  }
  return normalized;
}

function transportOptions(node, proxy) {
  const network = String(node.network || 'tcp').toLowerCase();
  if (!SUPPORTED_TRANSPORTS.has(network)) {
    throw new Error(`unsupported_proxy_transport_${network || 'empty'}`);
  }
  // mihomo 没有独立的 httpupgrade 网络：它是 ws-opts 上的 v2ray-http-upgrade 开关。
  proxy.network = network === 'httpupgrade' ? 'ws' : network;
  if (network === 'ws' || network === 'httpupgrade') {
    proxy['ws-opts'] = {
      path: node.path || '/',
      headers: node.host ? { Host: node.host } : undefined,
      ...(network === 'httpupgrade' ? { 'v2ray-http-upgrade': true } : {})
    };
  }
  if (network === 'grpc') {
    proxy['grpc-opts'] = {
      'grpc-service-name': node.serviceName || ''
    };
  }
  if (network === 'h2') {
    proxy['h2-opts'] = {
      host: node.host ? [node.host] : undefined,
      path: node.path || '/'
    };
  }
  if (network === 'http') {
    proxy['http-opts'] = {
      method: 'GET',
      path: [node.path || '/'],
      headers: node.host ? { Host: [node.host] } : undefined
    };
  }
  // XHTTP：mihomo 用独立的 network 名与 xhttp-opts（mode 由节点给出，缺省交给内核）。
  if (network === 'xhttp') {
    proxy['xhttp-opts'] = {
      path: node.path || '/',
      host: node.host || undefined,
      mode: node.mode || undefined
    };
  }
}

function tlsOptions(node, proxy) {
  if (node.tls) proxy.tls = true;
  if (node.sni) proxy.servername = node.sni;
  if (node.alpn) {
    proxy.alpn = Array.isArray(node.alpn)
      ? node.alpn.map(String)
      : String(node.alpn).split(',').map((value) => value.trim()).filter(Boolean);
  }
  if (node.allowInsecure || node.insecure) proxy['skip-cert-verify'] = true;
}

module.exports = {
  normalizePluginOptions,
  requiredString,
  tlsOptions,
  transportOptions
};
