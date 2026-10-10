'use strict';

// Quantumult X 节点参数的通用拼装（供各协议插件的 compile['quantumult-x'] 复用）。QX 把 TLS 与
// 传输合在 obfs 里：over-tls（tcp+TLS）/ ws / wss（ws+TLS）/ http（HTTP/1.1 伪装）。

const { normalizePluginOptions } = require('../mihomo/proxy-fields');
const { surgeError } = require('./proxy-fields');

function tlsVerification(node) {
  return node.allowInsecure === true || node.insecure === true ? false : undefined;
}

function quantumultXObfsParams(node, options = {}) {
  const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
  const tls = options.forceTls === true || node.tls === true || String(node.security || '').toLowerCase() === 'reality';
  if (network === 'tcp') return tls ? { obfs: 'over-tls', 'obfs-host': node.sni || undefined } : {};
  if (network === 'ws') {
    return { obfs: tls ? 'wss' : 'ws', 'obfs-host': node.host || node.sni || undefined, 'obfs-uri': node.path || '/' };
  }
  if (network === 'http' && !tls) return { obfs: 'http', 'obfs-host': node.host || undefined, 'obfs-uri': node.path || '/' };
  throw surgeError(`unsupported_proxy_transport_${network}`);
}

/** Shadowsocks 插件：simple-obfs → obfs=http|tls；v2ray-plugin(websocket) → obfs=ws|wss。 */
function quantumultXShadowsocksObfs(node) {
  const plugin = String(node.plugin || '').trim();
  if (!plugin) return {};
  const options = normalizePluginOptions(node.pluginOpts) || {};
  if (['obfs', 'obfs-local', 'simple-obfs'].includes(plugin)) {
    const mode = String(options.obfs || options.mode || '').trim();
    if (!['http', 'tls'].includes(mode)) throw surgeError('unsupported_shadowsocks_plugin_options');
    return {
      obfs: mode,
      'obfs-host': options['obfs-host'] || options.host || undefined,
      'obfs-uri': mode === 'http' ? options['obfs-uri'] || options.path || undefined : undefined
    };
  }
  if (plugin === 'v2ray-plugin' && String(options.mode || 'websocket') === 'websocket') {
    return {
      obfs: options.tls === true || options.tls === 'true' ? 'wss' : 'ws',
      'obfs-host': options.host || undefined,
      'obfs-uri': options.path || '/'
    };
  }
  throw surgeError(`unsupported_shadowsocks_plugin_${plugin}`);
}

module.exports = {
  quantumultXObfsParams,
  quantumultXShadowsocksObfs,
  tlsVerification
};
