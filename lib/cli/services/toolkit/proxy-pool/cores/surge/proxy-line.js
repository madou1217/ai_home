'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const { formatSurgeLine } = require('../../protocol-parsers/surge-line');
const { SUPPORTED_PROTOCOLS, isValidPort, normalizeProtocol } = require('../../proxy-protocol-contract');
const { surgeError } = require('./proxy-fields');

/**
 * 节点 → Surge 系代理行（target 即协议插件的编译目标：surge / loon …）。服务器与端口作为
 * 前两个位置参数，其余交给插件的 compile[target]，插件返回 { type, args?, params? }。
 */
function compileSurgeFamilyLine(target, rawNode, name) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const protocol = normalizeProtocol(node.protocol);
  const plugin = require('../../protocols').getProtocolPlugin(protocol);
  const compile = plugin && plugin.compile[target];
  if (!SUPPORTED_PROTOCOLS.has(protocol) || typeof compile !== 'function') {
    throw surgeError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = normalizeServerHost(node.server);
  if (!server) throw surgeError('invalid_proxy_server');
  if (!isValidPort(node.port)) throw surgeError('invalid_proxy_port');
  const line = compile({ ...node, protocol });
  return formatSurgeLine(name, {
    type: line.type,
    args: [server, Number(node.port), ...(line.args || [])],
    params: line.params || {}
  });
}

module.exports = {
  compileSurgeFamilyLine
};
