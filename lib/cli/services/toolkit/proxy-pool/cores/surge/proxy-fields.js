'use strict';

// Surge 系代理行参数的通用拼装（供各协议插件的 compile.surge 复用）。Surge 只支持 tcp / ws
// 传输与 simple-obfs 插件；表达不了的节点抛带 code 的错误，渲染时列为跳过项。

const { canonicalShadowsocksPlugin } = require('../../shadowsocks-plugin');

function surgeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredText(node, field) {
  const value = String(node[field] ?? '').trim();
  if (!value) throw surgeError(`missing_required_proxy_field_${field}`);
  return value;
}

function surgeTlsParams(node) {
  return {
    sni: node.sni || undefined,
    'skip-cert-verify': node.allowInsecure === true || node.insecure === true ? true : undefined
  };
}

/** ws 传输参数；tcp 返回空对象，其它传输 Surge 无法表达。 */
function surgeTransportParams(node) {
  const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
  if (network === 'tcp') return {};
  if (network !== 'ws') throw surgeError(`unsupported_proxy_transport_${network}`);
  return {
    ws: true,
    'ws-path': node.path || '/',
    'ws-headers': node.host ? `Host:${node.host}` : undefined
  };
}

/** Shadowsocks 插件：只认 simple-obfs（obfs / obfs-local / simple-obfs，见 shadowsocks-plugin）。 */
function surgeObfsParams(node) {
  const plugin = canonicalShadowsocksPlugin(node);
  if (!plugin) return {};
  if (plugin.name !== 'obfs') throw surgeError(`unsupported_shadowsocks_plugin_${plugin.name}`);
  if (!['http', 'tls'].includes(plugin.mode)) throw surgeError('unsupported_shadowsocks_plugin_options');
  return { obfs: plugin.mode, 'obfs-host': plugin.host, 'obfs-uri': plugin.uri };
}

/** Loon 的 TLS 参数（over-tls 开关 + sni）。 */
function loonTlsParams(node, options = {}) {
  const tls = options.forceTls === true || node.tls === true;
  return {
    'over-tls': options.forceTls === true ? undefined : (tls ? true : undefined),
    sni: tls ? node.sni || undefined : undefined,
    'skip-cert-verify': tls && (node.allowInsecure === true || node.insecure === true) ? true : undefined
  };
}

/** Loon 的传输参数：tcp / ws / http（HTTP/1.1 伪装）。 */
function loonTransportParams(node) {
  const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
  if (!['tcp', 'ws', 'http'].includes(network)) throw surgeError(`unsupported_proxy_transport_${network}`);
  return {
    transport: network,
    path: network === 'tcp' ? undefined : node.path || '/',
    host: network === 'tcp' ? undefined : node.host || undefined
  };
}

module.exports = {
  loonTlsParams,
  loonTransportParams,
  requiredText,
  surgeError,
  surgeObfsParams,
  surgeTlsParams,
  surgeTransportParams
};
