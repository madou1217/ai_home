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

function parseJsonOutbounds(rawText) {
  let parsedJson;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (_error) {
    return null;
  }
  const outbounds = Array.isArray(parsedJson) ? parsedJson : (parsedJson.outbounds || parsedJson.proxies || []);
  if (!Array.isArray(outbounds) || outbounds.length === 0) return null;
  const nodes = outbounds.map((ob) => {
    const type = String(ob?.type || '').toLowerCase();
    const server = ob?.server || ob?.server_name;
    const port = parseInt(ob?.server_port || ob?.port, 10);
    if (!server || !port) return null;
    return {
      protocol: type === 'shadowsocks' ? 'shadowsocks' : (type === 'hysteria2' ? 'hysteria2' : type),
      name: ob.tag || ob.name || 'JSON Node',
      server,
      port,
      uuid: ob.uuid,
      password: ob.password,
      cipher: ob.method || ob.cipher,
      tls: Boolean(ob.tls)
    };
  }).filter(Boolean);
  return nodes.length > 0 ? { nodes, skippedNodes: [], warnings: [] } : null;
}

// 整份订阅是 base64（单行，或按 76 列换行的 MIME 形式）时解出正文；解出来不像订阅就放弃，
// 避免把恰好只含 base64 字符的普通文本误当成编码内容。
function decodeBase64Subscription(text) {
  if (text.includes('://')) return '';
  const compact = text.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/_-]+=*$/.test(compact)) return '';
  const decoded = safeBase64Decode(compact);
  return /:\/\/|^\s*proxies\s*:|^\s*[{[]/m.test(decoded) ? decoded : '';
}

function parseUriLines(text) {
  const nodes = [];
  const skippedNodes = [];
  for (const line of text.split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const scheme = (line.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1];
    if (!scheme) continue;
    const node = parseProxyNode(line);
    if (node) {
      nodes.push(node);
      continue;
    }
    skippedNodes.push({
      nodeId: null,
      name: null,
      reason: findProtocolPluginForUri(line)
        ? `invalid_proxy_link_${scheme.toLowerCase()}`
        : `unsupported_proxy_protocol_${scheme.toLowerCase()}`
    });
  }
  return { nodes, skippedNodes, warnings: [] };
}

/**
 * 订阅正文 → { nodes, skippedNodes, warnings }。依次识别：Clash / mihomo YAML、JSON 出站列表、
 * base64 包裹的任意正文（解开后再识别一次）、逐行分享链接。
 */
function parseSubscriptionContentDetailed(content, depth = 0) {
  const rawText = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!rawText) return { nodes: [], skippedNodes: [], warnings: [] };

  // 看着像 Clash 但解析失败时先记下它的警告：其它格式也认不出时把原因交给调用方。
  let clashAttempt = null;
  if (/^\s*proxies\s*:/m.test(rawText)) {
    clashAttempt = parseClashYamlProxiesDetailed(rawText);
    if (clashAttempt.nodes.length > 0 || clashAttempt.skippedNodes.length > 0) return clashAttempt;
  }
  if (rawText.startsWith('{') || rawText.startsWith('[')) {
    const json = parseJsonOutbounds(rawText);
    if (json) return json;
  }
  if (depth === 0) {
    const decoded = decodeBase64Subscription(rawText);
    if (decoded) return parseSubscriptionContentDetailed(decoded, depth + 1);
  }
  const lines = parseUriLines(rawText);
  if (clashAttempt && lines.nodes.length === 0 && lines.skippedNodes.length === 0) return clashAttempt;
  return lines;
}

function parseSubscriptionContent(content) {
  return parseSubscriptionContentDetailed(content).nodes;
}

module.exports = {
  parseProxyNode,
  encodeProxyNode,
  parseSubscriptionContent,
  parseSubscriptionContentDetailed,
  parseClashYamlProxies,
  parseClashYamlProxiesDetailed
};
