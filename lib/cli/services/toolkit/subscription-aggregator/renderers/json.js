'use strict';

const { getProtocolPlugin, normalizeProtocol } = require('../../proxy-pool/protocols');

/** 中立 JSON：节点名、协议、服务器与协议字段（不含策略组与规则），供其它工具二次处理。 */
module.exports = Object.freeze({
  id: 'json',
  name: 'JSON（节点数据）',
  contentType: 'application/json; charset=utf-8',
  extension: 'json',
  capabilities: Object.freeze({ rejectInGroups: true, groups: false }),
  compileNode(entry) {
    const protocol = normalizeProtocol(entry.node.protocol);
    const plugin = getProtocolPlugin(protocol);
    if (!plugin) {
      const error = new Error(`unsupported_proxy_protocol_${protocol || 'empty'}`);
      error.code = error.message;
      throw error;
    }
    const fields = Object.keys(plugin.fields || {})
      .filter((field) => entry.node[field] !== undefined && entry.node[field] !== '')
      .map((field) => [field, entry.node[field]]);
    return {
      name: entry.name,
      protocol,
      server: entry.node.server,
      port: Number(entry.node.port),
      ...Object.fromEntries(fields)
    };
  },
  render(_plan, nodes) {
    return `${JSON.stringify({ version: 1, nodes }, null, 2)}\n`;
  }
});
