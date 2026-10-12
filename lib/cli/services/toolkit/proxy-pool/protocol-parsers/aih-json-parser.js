'use strict';

// 本系统的中立 JSON（订阅聚合 json 输出、手动填写的节点）→ 节点：{ version: 1, nodes: [{ name, protocol,
// server, port, …协议字段 }] }。字段名就是节点库的字段名，只保留协议插件声明过的字段。

const { buildImportedNode, importError } = require('./imported-node');

/** 不是这个形状（version 为 1、nodes 是带 protocol 的对象列表）时返回 null。 */
function readNodes(text) {
  let document;
  try {
    document = JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document) || Number(document.version) !== 1) return null;
  const nodes = document.nodes;
  const looksLikeAih = Array.isArray(nodes) && nodes.some((item) => item && typeof item === 'object' && typeof item.protocol === 'string');
  return looksLikeAih ? nodes : null;
}

function convertNode(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw importError('invalid_aih_json_node');
  const { getProtocolPlugin, normalizeProtocol } = require('../protocols');
  const protocol = normalizeProtocol(item.protocol);
  const plugin = getProtocolPlugin(protocol);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  const fields = Object.fromEntries(Object.keys(plugin.fields || {})
    .filter((field) => item[field] !== undefined && item[field] !== null && item[field] !== '')
    .map((field) => [field, item[field]]));
  return buildImportedNode({ plugin, name: item.name, server: item.server, port: item.port, fields: { ...fields, protocol } });
}

function parseAihJsonDetailed(text) {
  const items = readNodes(text);
  if (!items) return null;
  const nodes = [];
  const skippedNodes = [];
  for (const item of items) {
    try {
      nodes.push(convertNode(item));
    } catch (error) {
      skippedNodes.push({ nodeId: null, name: item && item.name ? String(item.name) : null, reason: error.code || error.message });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

module.exports = {
  parseAihJsonDetailed
};
