'use strict';

const { safeBase64Decode } = require('./base-parser');
const { findProtocolPluginForUri, getProtocolPlugin } = require('../protocols');
const { parseClashYamlProxies, parseClashYamlProxiesDetailed } = require('./clash-yaml-parser');

/**
 * Universal Single Node Parser：按分享链接 scheme 交给认领它的协议插件解析。
 */
function parseProxyNode(link) {
  const clean = String(link || '').trim();
  if (!clean) return null;
  const plugin = findProtocolPluginForUri(clean);
  return plugin ? plugin.parse(clean) : null;
}

/**
 * Encode a proxy node back to a standard URI（由节点协议对应的插件编码）。
 */
function encodeProxyNode(node) {
  if (!node || !node.protocol) return '';
  const plugin = getProtocolPlugin(node.protocol);
  return plugin ? plugin.encode(node) : '';
}

/**
 * Universal Subscription / Text Bulk Importer
 * Supports:
 * - Line-separated URI links (ss://, vmess://, vless://, etc.)
 * - Base64 encoded subscription content
 * - Clash YAML configuration
 * - Sing-box JSON configuration
 */
function parseSubscriptionContent(content) {
  const rawText = String(content || '').trim();
  if (!rawText) return [];

  // 1. Try Clash YAML
  if (/^proxies\s*:/m.test(rawText)) {
    const clashNodes = parseClashYamlProxies(rawText);
    if (clashNodes.length > 0) return clashNodes;
  }

  // 2. Try JSON (sing-box or general)
  if (rawText.startsWith('{') || rawText.startsWith('[')) {
    try {
      const parsedJson = JSON.parse(rawText);
      const outbounds = Array.isArray(parsedJson) ? parsedJson : (parsedJson.outbounds || parsedJson.proxies || []);
      if (Array.isArray(outbounds) && outbounds.length > 0) {
        const nodes = outbounds.map((ob) => {
          const type = (ob.type || '').toLowerCase();
          const server = ob.server || ob.server_name;
          const port = parseInt(ob.server_port || ob.port, 10);
          const name = ob.tag || ob.name || 'JSON Node';
          if (!server || !port) return null;
          return {
            protocol: type === 'shadowsocks' ? 'shadowsocks' : (type === 'hysteria2' ? 'hysteria2' : type),
            name,
            server,
            port,
            uuid: ob.uuid,
            password: ob.password,
            cipher: ob.method || ob.cipher,
            tls: Boolean(ob.tls)
          };
        }).filter(Boolean);
        if (nodes.length > 0) return nodes;
      }
    } catch (_e) {
      // not json, continue
    }
  }

  // 3. Try plain text lines or Base64 decoded text lines
  let decodedText = rawText;
  if (!rawText.includes('\n') && !rawText.includes('://')) {
    const attempt = safeBase64Decode(rawText);
    if (attempt && (attempt.includes('://') || attempt.includes('proxies:'))) {
      decodedText = attempt;
    }
  }

  const lines = decodedText.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    const node = parseProxyNode(line);
    if (node) {
      results.push(node);
    }
  }

  return results;
}

module.exports = {
  parseProxyNode,
  encodeProxyNode,
  parseSubscriptionContent,
  parseClashYamlProxies,
  parseClashYamlProxiesDetailed
};
