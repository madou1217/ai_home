'use strict';

const { safeBase64Decode } = require('./base-parser');
const { findProtocolPluginForUri, getProtocolPlugin } = require('../protocols');
const { parseClashYamlProxies, parseClashYamlProxiesDetailed } = require('./clash-yaml-parser');
const { parseSingBoxOutboundsDetailed } = require('./sing-box-config-parser');
const { looksLikeQuantumultXConfig, parseQuantumultXServersDetailed } = require('./quantumult-x-config-parser');
const { looksLikeSurgeConfig, parseSurgeProxiesDetailed } = require('./surge-config-parser');

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
 * 订阅正文 → { nodes, skippedNodes, warnings }。依次识别：Clash / mihomo YAML、sing-box 配置
 * （或 JSON 写法的 Clash）、Quantumult X 节点行、Surge / Surfboard / Loon 代理行、
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
    const singBox = parseSingBoxOutboundsDetailed(rawText);
    if (singBox) return singBox;
    // JSON 写法的 Clash 配置（YAML 是 JSON 的超集，同一个解析器即可读）。
    if (/"proxies"\s*:/.test(rawText)) {
      const clashJson = parseClashYamlProxiesDetailed(rawText);
      if (clashJson.nodes.length > 0 || clashJson.skippedNodes.length > 0) return clashJson;
    }
  }
  // QX 行（type=host:port, …）先于 Surge 行判断：后者的宽松匹配也会命中 `vmess=host:port`。
  if (!rawText.includes('://') && looksLikeQuantumultXConfig(rawText)) {
    const quantumultX = parseQuantumultXServersDetailed(rawText);
    if (quantumultX.nodes.length > 0 || quantumultX.skippedNodes.length > 0) return quantumultX;
  }
  if (!rawText.includes('://') && looksLikeSurgeConfig(rawText)) {
    const surge = parseSurgeProxiesDetailed(rawText);
    if (surge.nodes.length > 0 || surge.skippedNodes.length > 0) return surge;
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
