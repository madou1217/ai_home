'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const {
  SUPPORTED_PROTOCOLS,
  isValidPort,
  normalizeProtocol
} = require('../../proxy-protocol-contract');
const { getProtocolPlugin } = require('../../protocols');
const { configError, requiredString } = require('./outbound-fields');

function requiredPort(value, code) {
  if (!isValidPort(value)) throw configError(code);
  return Number(value);
}

/**
 * 把代理池节点编译为 sing-box outbound：通用字段（type/tag/server/server_port）在这里校验，
 * 协议字段交给协议插件的 compile['sing-box']。供订阅聚合的 sing-box 输出使用。
 */
function compileSingBoxNodeOutbound(rawNode, tag) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const protocol = normalizeProtocol(node.protocol);
  const plugin = getProtocolPlugin(protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol) || !plugin || typeof plugin.compile['sing-box'] !== 'function') {
    throw configError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = requiredString(normalizeServerHost(node.server), 'invalid_proxy_server');
  const serverPort = requiredPort(node.port, 'invalid_proxy_port');
  const base = { type: protocol, tag, server, server_port: serverPort };
  return plugin.compile['sing-box']({ ...node, protocol }, base);
}

module.exports = {
  compileSingBoxNodeOutbound,
  requiredPort
};
