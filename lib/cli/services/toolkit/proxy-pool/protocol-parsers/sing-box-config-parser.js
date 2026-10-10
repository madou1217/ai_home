'use strict';

// sing-box 配置（JSON，容忍注释与尾逗号）→ 节点：读取 outbounds，跳过直连 / 阻断 / 策略组
// 等非代理出站，其余交给认领该类型的协议插件（imports['sing-box']）。

const { parse: parseJsonc } = require('jsonc-parser');
const { buildImportedNode, importError } = require('./imported-node');

const NON_PROXY_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest', 'loadbalance']);

function findSingBoxPlugin(type) {
  return require('../protocols').findProtocolPluginForImport('sing-box', type);
}

/** 不是 sing-box 形状（没有 outbounds 列表、条目不带 server_port）时返回 null。 */
function readOutbounds(text) {
  const errors = [];
  const document = parseJsonc(String(text || ''), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !document || typeof document !== 'object') return null;
  const outbounds = Array.isArray(document) ? document : document.outbounds;
  if (!Array.isArray(outbounds)) return null;
  const looksLikeSingBox = outbounds.some((item) => item && typeof item === 'object'
    && typeof item.type === 'string' && (item.server_port !== undefined || NON_PROXY_TYPES.has(item.type)));
  return looksLikeSingBox ? outbounds : null;
}

function convertOutbound(outbound) {
  if (!outbound || typeof outbound !== 'object' || Array.isArray(outbound)) throw importError('invalid_sing_box_outbound');
  const type = String(outbound.type || '').trim().toLowerCase();
  const plugin = findSingBoxPlugin(type);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${type || 'empty'}`);
  return buildImportedNode({
    plugin,
    name: outbound.tag ?? 'sing-box Node',
    server: outbound.server,
    port: outbound.server_port,
    fields: plugin.imports['sing-box'].parse(outbound)
  });
}

function parseSingBoxOutboundsDetailed(text) {
  const outbounds = readOutbounds(text);
  if (!outbounds) return null;
  const nodes = [];
  const skippedNodes = [];
  for (const outbound of outbounds) {
    if (NON_PROXY_TYPES.has(String(outbound?.type || '').toLowerCase())) continue;
    try {
      nodes.push(convertOutbound(outbound));
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
