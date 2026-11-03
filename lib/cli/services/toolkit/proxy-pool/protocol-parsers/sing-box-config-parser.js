'use strict';

// sing-box 配置（JSON，容忍注释与尾逗号）→ 节点：读取 outbounds 与 endpoints（1.11 起 WireGuard 在这里），
// 跳过直连 / 阻断 / 策略组等非代理出站，其余交给认领该类型的协议插件（imports['sing-box']）。
//
// 一个节点可能由多个出站拼成：ShadowTLS 的 ss 出站用 detour 指向同服务器的 shadowtls 出站。解析时
// 先按 tag 把全部出站索引一遍，再把 detour 目标交给插件合并；辅助出站本身不产生节点。

const { parse: parseJsonc } = require('jsonc-parser');
const { buildImportedNode, importError } = require('./imported-node');

const NON_PROXY_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest', 'loadbalance']);
// 只能被别的出站用 detour 引用的传输层出站：不单独成为节点。
const AUXILIARY_TYPES = new Set(['shadowtls']);

function findSingBoxPlugin(type) {
  return require('../protocols').findProtocolPluginForImport('sing-box', type);
}

/** 不是 sing-box 形状（outbounds 条目不带 server_port / server_ports、也没有带对端的 endpoints）时返回 null。 */
function readOutbounds(text) {
  const errors = [];
  const document = parseJsonc(String(text || ''), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !document || typeof document !== 'object') return null;
  const outbounds = Array.isArray(document) ? document : (Array.isArray(document.outbounds) ? document.outbounds : []);
  const endpoints = !Array.isArray(document) && Array.isArray(document.endpoints) ? document.endpoints : [];
  const isEntry = (item) => item && typeof item === 'object' && typeof item.type === 'string';
  const looksLikeSingBox = outbounds.some((item) => isEntry(item)
    && (item.server_port !== undefined || Array.isArray(item.server_ports) || NON_PROXY_TYPES.has(item.type)))
    || endpoints.some((item) => isEntry(item) && Array.isArray(item.peers));
  return looksLikeSingBox ? [...outbounds, ...endpoints] : null;
}

function convertOutbound(outbound, byTag) {
  if (!outbound || typeof outbound !== 'object' || Array.isArray(outbound)) throw importError('invalid_sing_box_outbound');
  const type = String(outbound.type || '').trim().toLowerCase();
  const plugin = findSingBoxPlugin(type);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${type || 'empty'}`);
  const detour = byTag.get(String(outbound.detour ?? '').trim());
  return buildImportedNode({
    plugin,
    name: outbound.tag ?? 'sing-box Node',
    server: outbound.server,
    port: outbound.server_port,
    fields: plugin.imports['sing-box'].parse(outbound, { detour })
  });
}

/** tag → 出站：detour 只能按 tag 引用，所以先把整份配置索引一遍再逐条转换。 */
function outboundsByTag(outbounds) {
  const map = new Map();
  for (const outbound of outbounds) {
    const tag = outbound && typeof outbound.tag === 'string' ? outbound.tag.trim() : '';
    if (tag && !map.has(tag)) map.set(tag, outbound);
  }
  return map;
}

function parseSingBoxOutboundsDetailed(text) {
  const outbounds = readOutbounds(text);
  if (!outbounds) return null;
  const byTag = outboundsByTag(outbounds);
  const nodes = [];
  const skippedNodes = [];
  for (const outbound of outbounds) {
    const type = String(outbound?.type || '').toLowerCase();
    // 辅助出站（ShadowTLS）已经合并进引用它的那个节点，不单独出现。
    if (NON_PROXY_TYPES.has(type) || AUXILIARY_TYPES.has(type)) continue;
    try {
      nodes.push(convertOutbound(outbound, byTag));
    } catch (error) {
      skippedNodes.push({
        nodeId: null,
        name: outbound && outbound.tag !== undefined ? String(outbound.tag) : null,
        reason: error.code || error.message
      });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

module.exports = {
  parseSingBoxOutboundsDetailed
};
