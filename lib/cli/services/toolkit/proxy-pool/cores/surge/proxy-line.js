'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const { formatQuantumultXLine } = require('../../protocol-parsers/quantumult-x-line');
const { formatSurgeLine } = require('../../protocol-parsers/surge-line');
const { SUPPORTED_PROTOCOLS, isValidPort, normalizeProtocol } = require('../../proxy-protocol-contract');
const { surgeError } = require('./proxy-fields');

/**
 * 节点 → Surge 系代理行（target 即协议插件的编译目标：surge / loon …）。服务器与端口作为
 * 前两个位置参数，其余交给插件的 compile[target]，插件返回 { type, args?, params? }。
 */
function resolveCompile(target, node) {
  const protocol = normalizeProtocol(node.protocol);
  const plugin = require('../../protocols').getProtocolPlugin(protocol);
  const compile = plugin && plugin.compile[target];
  if (!SUPPORTED_PROTOCOLS.has(protocol) || typeof compile !== 'function') {
    throw surgeError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = normalizeServerHost(node.server);
  if (!server) throw surgeError('invalid_proxy_server');
  if (!isValidPort(node.port)) throw surgeError('invalid_proxy_port');
  return { protocol, compile, server, port: Number(node.port) };
}

function compileSurgeFamilyLine(target, rawNode, name) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const { protocol, compile, server, port } = resolveCompile(target, node);
  const line = compile({ ...node, protocol });
  return formatSurgeLine(name, {
    type: line.type,
    args: [server, port, ...(line.args || [])],
    params: line.params || {}
  });
}

/** 节点 → Quantumult X 的 [server_local] 行；插件的 compile['quantumult-x'] 返回 { type, params }。 */
function compileQuantumultXLine(rawNode, name) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const { protocol, compile, server, port } = resolveCompile('quantumult-x', node);
  const line = compile({ ...node, protocol });
  return formatQuantumultXLine(name, { type: line.type, server, port, params: line.params || {} });
}

module.exports = {
  compileQuantumultXLine,
  compileSurgeFamilyLine
};
