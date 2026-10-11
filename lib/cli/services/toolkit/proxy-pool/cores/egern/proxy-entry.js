'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const { SUPPORTED_PROTOCOLS, isValidPort, normalizeProtocol } = require('../../proxy-protocol-contract');
const { protocolFieldError } = require('../../protocol-fields');

/**
 * 节点 → Egern 代理条目 `{ <类型>: { name, server, port, … } }`：通用字段在这里校验，
 * 协议字段交给插件的 compile.egern（返回 { type, fields }）。
 */
function compileEgernProxy(rawNode, name) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const protocol = normalizeProtocol(node.protocol);
  const plugin = require('../../protocols').getProtocolPlugin(protocol);
  const compile = plugin && plugin.compile.egern;
  if (!SUPPORTED_PROTOCOLS.has(protocol) || typeof compile !== 'function') {
    throw protocolFieldError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = normalizeServerHost(node.server);
  if (!server) throw protocolFieldError('invalid_proxy_server');
  if (!isValidPort(node.port)) throw protocolFieldError('invalid_proxy_port');
  const { type, fields } = compile({ ...node, protocol });
  return { [type]: { name, server, port: Number(node.port), ...fields } };
}

/** 有 compile.egern 的协议（Egern 渲染器能输出的协议）。 */
function egernProtocols() {
  return require('../../protocols').PROTOCOL_PLUGINS
    .filter((plugin) => typeof plugin.compile.egern === 'function')
    .flatMap((plugin) => plugin.protocols);
}

module.exports = {
  compileEgernProxy,
  egernProtocols
};
