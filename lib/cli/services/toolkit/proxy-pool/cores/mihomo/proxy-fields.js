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
  proxy.network = network;
  if (network === 'ws') {
    proxy['ws-opts'] = {
      path: node.path || '/',
      headers: node.host ? { Host: node.host } : undefined
    };
  }
  if (network === 'grpc') {
    proxy['grpc-opts'] = {
      'grpc-service-name': node.serviceName || ''
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
