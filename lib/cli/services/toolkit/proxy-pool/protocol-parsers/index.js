'use strict';

const { safeBase64Decode } = require('./base-parser');
const { findProtocolPluginForUri, getProtocolPlugin } = require('../protocols');
const { parseAihJsonDetailed } = require('./aih-json-parser');
const { parseClashYamlProxies, parseClashYamlProxiesDetailed } = require('./clash-yaml-parser');
const { parseEgernProxiesDetailed } = require('./egern-config-parser');
const { parseSingBoxOutboundsDetailed } = require('./sing-box-config-parser');
const { parseXrayConfigDetailed } = require('./xray-config-parser');
const { parseSip008Detailed } = require('./sip008-parser');
const { looksLikeQuantumultXConfig, parseQuantumultXServersDetailed } = require('./quantumult-x-config-parser');
const { looksLikeSurgeConfig, parseSurgeProxiesDetailed } = require('./surge-config-parser');
const { parseWireGuardConfDetailed } = require('./wireguard-conf-parser');

/** 结果标上识别出的格式（解析预览展示；base64 包裹的写成 base64+<内层格式>）。 */
function tagged(result, format) {
  return { ...result, format };
}

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
 * 订阅正文 → { nodes, skippedNodes, warnings, format }。依次识别：Egern YAML、Clash / mihomo YAML、
 * JSON（本系统的中立 JSON、sing-box、Xray / V2Ray、JSON 写法的 Clash、SIP008）、WireGuard 配置文件、
 * Quantumult X 节点行、Surge / Surfboard / Loon 代理行、base64 包裹的任意正文（解开后再识别一次）、
 * 逐行分享链接。format 是识别出的格式（认不出时为空串）。
 */
function parseSubscriptionContentDetailed(content, depth = 0) {
  const rawText = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!rawText) return { nodes: [], skippedNodes: [], warnings: [], format: '' };

  // Egern 的 proxies 是「类型: { … }」单键映射，必须先于 Clash 认领：Clash 会把每个条目当成缺 type
  // 的代理逐条列为跳过项并就此返回。Clash 的条目不是单键映射，Egern 不会认领它们。
  const egern = parseEgernProxiesDetailed(rawText);
  if (egern) return tagged(egern, 'egern');
  // 看着像 Clash 但解析失败时先记下它的警告：其它格式也认不出时把原因交给调用方。
  let clashAttempt = null;
  if (/^\s*proxies\s*:/m.test(rawText)) {
    clashAttempt = tagged(parseClashYamlProxiesDetailed(rawText), 'clash');
    if (clashAttempt.nodes.length > 0 || clashAttempt.skippedNodes.length > 0) return clashAttempt;
  }
  if (rawText.startsWith('{') || rawText.startsWith('[')) {
    // 本系统的中立 JSON（{ version: 1, nodes }）最具体，先认。
    const aihJson = parseAihJsonDetailed(rawText);
    if (aihJson) return tagged(aihJson, 'aih-json');
    const singBox = parseSingBoxOutboundsDetailed(rawText);
    if (singBox) return tagged(singBox, 'sing-box');
    // Xray / V2Ray 配置（或配置数组）：出站用 protocol 而不是 type，sing-box 的识别不会认领它。
    const xray = parseXrayConfigDetailed(rawText);
    if (xray) return tagged(xray, 'xray');
    // JSON 写法的 Clash 配置（YAML 是 JSON 的超集，同一个解析器即可读）。
    if (/"proxies"\s*:/.test(rawText)) {
      const clashJson = parseClashYamlProxiesDetailed(rawText);
      if (clashJson.nodes.length > 0 || clashJson.skippedNodes.length > 0) return tagged(clashJson, 'clash');
    }
    const sip008 = parseSip008Detailed(rawText);
    if (sip008) return tagged(sip008, 'sip008');
  }
  // WireGuard 配置文件（[Interface] + [Peer]）：段名与 Surge / QX 的分段都不重合。
  const wireguard = parseWireGuardConfDetailed(rawText);
  if (wireguard) return tagged(wireguard, 'wireguard');
  // 完整配置里的 URL（托管地址、规则集、远程资源）只出现在行中或分段里；有行以分享链接开头时，
  // 只凭分段标记（[server_local] / [Proxy]）认 QX 与 Surge，不按宽松的行格式猜。
  const sectionsOnly = /^\s*[a-z][a-z0-9+.-]*:\/\//im.test(rawText);
  // QX 行（type=host:port, …）先于 Surge 行判断：后者的宽松匹配也会命中 `vmess=host:port`。
  if (looksLikeQuantumultXConfig(rawText, { sectionsOnly })) {
    const quantumultX = parseQuantumultXServersDetailed(rawText);
    if (quantumultX.nodes.length > 0 || quantumultX.skippedNodes.length > 0) return tagged(quantumultX, 'quantumult-x');
  }
  if (looksLikeSurgeConfig(rawText, { sectionsOnly })) {
    const surge = parseSurgeProxiesDetailed(rawText);
    if (surge.nodes.length > 0 || surge.skippedNodes.length > 0) return tagged(surge, 'surge');
  }
  if (depth === 0) {
    const decoded = decodeBase64Subscription(rawText);
    if (decoded) {
      const inner = parseSubscriptionContentDetailed(decoded, depth + 1);
      return tagged(inner, inner.format ? `base64+${inner.format}` : 'base64');
    }
  }
  const lines = parseUriLines(rawText);
  if (clashAttempt && lines.nodes.length === 0 && lines.skippedNodes.length === 0) return clashAttempt;
  return tagged(lines, lines.nodes.length || lines.skippedNodes.length ? 'uri' : '');
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
