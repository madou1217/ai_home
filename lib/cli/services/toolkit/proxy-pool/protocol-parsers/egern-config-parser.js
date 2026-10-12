'use strict';

// Egern 配置（YAML）→ 节点：顶层 proxies 是「类型: { name, server, port, … }」单键映射的列表，有的导出
// 只有这个列表本身。策略组与内置策略静默跳过，代理条目交给认领该类型的协议插件（imports.egern）。

const YAML = require('yaml');
const { buildImportedNode, importError } = require('./imported-node');

// Egern 文档列出的代理类型（ssh、socks5_tls 等 AIH 没有对应协议的也列上，导入时如实列为跳过项）。
const PROXY_TYPES = Object.freeze([
  'shadowsocks', 'snell', 'trojan', 'anytls', 'hysteria2', 'tuic', 'socks5', 'socks5_tls', 'ssh',
  'http', 'https', 'vmess', 'vless', 'wireguard'
]);
// 策略组与内置策略：不是节点。
const NON_PROXY_TYPES = new Set(['select', 'auto_test', 'smart', 'fallback', 'load_balance', 'external', 'conditional', 'direct', 'reject']);
const KNOWN_TYPES = new Set([...PROXY_TYPES, ...NON_PROXY_TYPES]);
// 预检：至少一行是「- 代理类型:」才值得按 YAML 解析。Clash 的条目以 name / type 开头，
// DNS 列表里的 `- https://…` 冒号后不是空白，都不会命中。
const ENTRY_LINE = new RegExp(`^[ \\t]*-[ \\t]*\\{?[ \\t]*["']?(?:${PROXY_TYPES.join('|')})["']?[ \\t]*:(?:\\s|$)`, 'm');

function findEgernPlugin(type) {
  return require('../protocols').findProtocolPluginForImport('egern', type);
}

function isMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 单键映射 → { type, proxy }；不是这种形状时返回 null。 */
function entryOf(item) {
  if (!isMap(item)) return null;
  const keys = Object.keys(item);
  if (keys.length !== 1 || !isMap(item[keys[0]])) return null;
  return { type: keys[0].trim().toLowerCase(), proxy: item[keys[0]] };
}

/**
 * 不是 Egern 形状时返回 null：列表里每一项都得是单键映射、且至少有一个键是 Egern 的类型。
 * 不认识的键按代理类型处理（新版 Egern 的类型），导入时列为跳过项。
 */
function readEntries(text) {
  if (!ENTRY_LINE.test(text)) return null;
  let document;
  try {
    document = YAML.parse(text, { uniqueKeys: false, merge: true });
  } catch (_error) {
    return null;
  }
  const list = Array.isArray(document) ? document : (isMap(document) && Array.isArray(document.proxies) ? document.proxies : null);
  if (!list || list.length === 0) return null;
  const entries = list.map(entryOf);
  if (entries.some((entry) => !entry) || !entries.some((entry) => KNOWN_TYPES.has(entry.type))) return null;
  return entries;
}

function convertEntry({ type, proxy }) {
  const plugin = findEgernPlugin(type);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${type || 'empty'}`);
  // 套了 ShadowTLS 的节点表达不了，丢掉这一层导入会连不上。
  if (proxy.shadow_tls) throw importError('unsupported_proxy_field_shadow_tls');
  return buildImportedNode({
    plugin,
    name: proxy.name ?? 'Egern Node',
    server: proxy.server,
    port: proxy.port,
    fields: plugin.imports.egern.parse(proxy, type)
  });
}

function parseEgernProxiesDetailed(text) {
  const entries = readEntries(String(text || ''));
  if (!entries) return null;
  const nodes = [];
  const skippedNodes = [];
  for (const entry of entries) {
    if (NON_PROXY_TYPES.has(entry.type)) continue;
    try {
      nodes.push(convertEntry(entry));
    } catch (error) {
      skippedNodes.push({
        nodeId: null,
        name: entry.proxy.name !== undefined ? String(entry.proxy.name) : null,
        reason: error.code || error.message
      });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

module.exports = {
  parseEgernProxiesDetailed
};
