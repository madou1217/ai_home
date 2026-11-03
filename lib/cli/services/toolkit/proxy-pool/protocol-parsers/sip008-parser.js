'use strict';

// SIP008（Shadowsocks 在线配置）→ 节点：{ version: 1, servers: [{ server, server_port, password, method,
// remarks, plugin, plugin_opts }] }。条目交给认领该格式的协议插件（imports.sip008）。

const { buildImportedNode, importError } = require('./imported-node');

function findPlugin() {
  return require('../protocols').findProtocolPluginForImport('sip008', 'shadowsocks');
}

/** 不是 SIP008 形状（没有带 server_port 与 method 的 servers 列表）时返回 null。 */
function readServers(text) {
  let document;
  try {
    document = JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
  const servers = document && typeof document === 'object' && !Array.isArray(document) ? document.servers : null;
  const looksLikeSip008 = Array.isArray(servers) && servers.some((item) => item && typeof item === 'object'
    && item.server_port !== undefined && item.method !== undefined);
  return looksLikeSip008 ? servers : null;
}

function parseSip008Detailed(text) {
  const servers = readServers(text);
  if (!servers) return null;
  const plugin = findPlugin();
  const nodes = [];
  const skippedNodes = [];
  for (const server of servers) {
    try {
      if (!server || typeof server !== 'object' || Array.isArray(server)) throw importError('invalid_sip008_server');
      nodes.push(buildImportedNode({
        plugin,
        name: server.remarks || `${server.server}:${server.server_port}`,
        server: server.server,
        port: server.server_port,
        fields: plugin.imports.sip008.parse(server)
      }));
    } catch (error) {
      skippedNodes.push({ nodeId: null, name: server && server.remarks ? String(server.remarks) : null, reason: error.code || error.message });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

module.exports = {
  parseSip008Detailed
};
