'use strict';

const { safeBase64Decode } = require('./base-parser');
const { parseSSLink, encodeSSLink } = require('./ss-parser');
const { parseVMessLink, encodeVMessLink } = require('./vmess-parser');
const { parseVLESSLink, encodeVLESSLink } = require('./vless-parser');
const { parseTrojanLink, encodeTrojanLink } = require('./trojan-parser');
const { parseHysteriaLink, encodeHysteriaLink } = require('./hysteria-parser');
const { parseStandardProxyLink, encodeStandardProxyLink } = require('./standard-parser');

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
 * Simple Clash YAML parser without large dependencies
 */
function parseClashYamlProxies(text) {
  const nodes = [];
  try {
    const lines = text.split('\n');
    let inProxies = false;
    let currentProxy = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^proxies:\s*$/i.test(trimmed)) {
        inProxies = true;
        continue;
      }
      if (inProxies && /^[a-zA-Z0-9_-]+:\s*$/.test(trimmed) && !line.startsWith(' ') && !line.startsWith('\t')) {
        inProxies = false;
        if (currentProxy) {
          nodes.push(currentProxy);
          currentProxy = null;
        }
        continue;
      }

      if (inProxies) {
        if (trimmed.startsWith('- ')) {
          if (currentProxy) {
            nodes.push(currentProxy);
          }
          currentProxy = {};
          const rest = trimmed.slice(2).trim();
          if (rest.includes(':')) {
            const [k, ...v] = rest.split(':');
            currentProxy[k.trim()] = v.join(':').trim().replace(/^['"]|['"]$/g, '');
          }
        } else if (currentProxy && trimmed.includes(':')) {
          const [k, ...v] = trimmed.split(':');
          currentProxy[k.trim()] = v.join(':').trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
    if (currentProxy) {
      nodes.push(currentProxy);
    }
  } catch (_e) {
    // fallback
  }

  return nodes.map((p) => {
    const type = (p.type || '').toLowerCase();
    const name = p.name || 'Clash Node';
    const server = p.server;
    const port = parseInt(p.port, 10);
    if (!server || !port) return null;

    if (type === 'ss' || type === 'shadowsocks') {
      return {
        protocol: 'shadowsocks',
        name,
        server,
        port,
        cipher: p.cipher,
        password: p.password
      };
    }
    if (type === 'vmess') {
      return {
        protocol: 'vmess',
        name,
        server,
        port,
        uuid: p.uuid,
        alterId: parseInt(p.alterId || 0, 10),
        cipher: p.cipher || 'auto',
        network: p.network || 'tcp',
        tls: p.tls === 'true' || Boolean(p.tls),
        sni: p.servername || p.sni || ''
      };
    }
    if (type === 'trojan') {
      return {
        protocol: 'trojan',
        name,
        server,
        port,
        password: p.password,
        sni: p.sni || p.servername || '',
        tls: true
      };
    }
    if (type === 'vless') {
      return {
        protocol: 'vless',
        name,
        server,
        port,
        uuid: p.uuid,
        network: p.network || 'tcp',
        tls: p.tls === 'true' || Boolean(p.tls),
        sni: p.servername || p.sni || ''
      };
    }
    if (type === 'hysteria2' || type === 'hy2') {
      return {
        protocol: 'hysteria2',
        name,
        server,
        port,
        password: p.password,
        sni: p.sni || '',
        tls: true
      };
    }
    if (type === 'socks5' || type === 'http') {
      return {
        protocol: type,
        name,
        server,
        port,
        username: p.username,
        password: p.password
      };
    }
    return null;
  }).filter(Boolean);
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
  if (rawText.includes('proxies:') && (rawText.includes('- name:') || rawText.includes('- type:'))) {
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
  parseSubscriptionContent
};
