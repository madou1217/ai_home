'use strict';

// Quantumult X 配置（或只有节点行的列表）→ 节点：读 [server_local] 段，没有分段时读全部行，
// 交给认领该类型的协议插件（imports['quantumult-x']）。

const { buildImportedNode, importError } = require('./imported-node');
const { parseQuantumultXLine } = require('./quantumult-x-line');

function findPlugin(type) {
  return require('../protocols').findProtocolPluginForImport('quantumult-x', type);
}

function serverLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hasSections = lines.some((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  let section = '';
  return lines.filter((line) => {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      return false;
    }
    return !hasSections || section === 'server_local';
  });
}

function convertLine(line) {
  const plugin = findPlugin(line.type);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${line.type}`);
  return buildImportedNode({
    plugin,
    name: line.name || `${line.server}:${line.port}`,
    server: line.server,
    port: line.port,
    fields: plugin.imports['quantumult-x'].parse(line)
  });
}

function parseQuantumultXServersDetailed(text) {
  const nodes = [];
  const skippedNodes = [];
  for (const raw of serverLines(text)) {
    const line = parseQuantumultXLine(raw);
    if (!line) continue;
    try {
      nodes.push(convertLine(line));
    } catch (error) {
      skippedNodes.push({ nodeId: null, name: line.name || null, reason: error.code || error.message });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

function looksLikeQuantumultXConfig(text) {
  return /^\s*\[server_local\]\s*$/mi.test(text)
    || /^\s*(?:shadowsocks|vmess|vless|trojan|http|socks5)\s*=\s*(?:\[[^\]]+\]|[^:,\s]+):\d{1,5}\s*,/mi.test(text);
}

module.exports = {
  looksLikeQuantumultXConfig,
  parseQuantumultXServersDetailed
};
