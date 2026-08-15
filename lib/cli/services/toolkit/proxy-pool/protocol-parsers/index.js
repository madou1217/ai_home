'use strict';

const { safeBase64Decode } = require('./base-parser');
const { parseSSLink, encodeSSLink } = require('./ss-parser');
const { parseVMessLink, encodeVMessLink } = require('./vmess-parser');
const { parseVLESSLink, encodeVLESSLink } = require('./vless-parser');
const { parseTrojanLink, encodeTrojanLink } = require('./trojan-parser');
const { parseHysteriaLink, encodeHysteriaLink } = require('./hysteria-parser');
const { parseStandardProxyLink, encodeStandardProxyLink } = require('./standard-parser');
const { parseClashYamlProxies, parseClashYamlProxiesDetailed } = require('./clash-yaml-parser');

/**
 * Universal Single Node Parser
 */
function parseProxyNode(link) {
  const clean = String(link || '').trim();
  if (!clean) return null;

  if (clean.startsWith('ss://')) return parseSSLink(clean);
  if (clean.startsWith('vmess://')) return parseVMessLink(clean);
  if (clean.startsWith('vless://')) return parseVLESSLink(clean);
  if (clean.startsWith('trojan://')) return parseTrojanLink(clean);
  if (clean.startsWith('hy2://') || clean.startsWith('hysteria2://') || clean.startsWith('hysteria://')) {
    return parseHysteriaLink(clean);
  }
  if (clean.startsWith('socks5://') || clean.startsWith('socks://') || clean.startsWith('http://') || clean.startsWith('https://')) {
    return parseStandardProxyLink(clean);
  }
  return null;
}

/**
 * Encode a proxy node back to a standard URI
 */
function encodeProxyNode(node) {
  if (!node || !node.protocol) return '';
  switch (node.protocol) {
    case 'shadowsocks': return encodeSSLink(node);
    case 'vmess': return encodeVMessLink(node);
    case 'vless': return encodeVLESSLink(node);
    case 'trojan': return encodeTrojanLink(node);
    case 'hysteria':
    case 'hysteria2': return encodeHysteriaLink(node);
    case 'socks5':
    case 'http':
    case 'https': return encodeStandardProxyLink(node);
    default: return '';
  }
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
