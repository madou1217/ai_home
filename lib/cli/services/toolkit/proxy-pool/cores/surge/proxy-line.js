'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const { formatQuantumultXLine } = require('../../protocol-parsers/quantumult-x-line');
const { formatSurgeLine } = require('../../protocol-parsers/surge-line');
const { SUPPORTED_PROTOCOLS, isValidPort, normalizeProtocol } = require('../../proxy-protocol-contract');
const { compiledLine, withExtras } = require('../../compile-result');
const { surgeError } = require('./proxy-fields');

// Surfboard 与 Surge 语法同源：插件没有单独的 compile.surfboard 时回落到 compile.surge。
const TARGET_FALLBACK = Object.freeze({ surfboard: 'surge' });

function compileFor(plugin, target) {
  const compile = plugin && plugin.compile ? plugin.compile[target] : null;
  if (typeof compile === 'function') return compile;
  const fallback = TARGET_FALLBACK[target];
  const inherited = fallback && plugin && plugin.compile ? plugin.compile[fallback] : null;
  return typeof inherited === 'function' ? inherited : null;
}

/**
 * 节点 → Surge 系代理行的编译结果（target 即协议插件的编译目标：surge / surfboard / loon …）。
 * 服务器与端口默认作为前两个位置参数；插件声明 omitAddress 时不写（WireGuard 的地址在段或
 * peers 里）。插件返回 { type, args?, params?, omitAddress?, sections? }：sections 是需要另起
 * 段落的附加内容（Surge / Surfboard 的 [WireGuard x]），挂到编译结果的 extras 上。
 */
function resolveCompile(target, node) {
  const protocol = normalizeProtocol(node.protocol);
  const plugin = require('../../protocols').getProtocolPlugin(protocol);
  const compile = SUPPORTED_PROTOCOLS.has(protocol) ? compileFor(plugin, target) : null;
  if (!compile) {
    throw surgeError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = normalizeServerHost(node.server);
  if (!server) throw surgeError('invalid_proxy_server');
  if (!isValidPort(node.port)) throw surgeError('invalid_proxy_port');
  return { protocol, compile, server, port: Number(node.port) };
}

function compileSurgeFamilyEntry(target, rawNode, name) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const { protocol, compile, server, port } = resolveCompile(target, node);
  // 归一化后的 server / port 一并交给插件：地址被写进附加段落（WireGuard）时用得到。
  const line = compile({ ...node, protocol, server, port });
  const args = line.omitAddress ? (line.args || []) : [server, port, ...(line.args || [])];
  return withExtras(
    { line: formatSurgeLine(name, { type: line.type, args, params: line.params || {} }) },
    line.sections
  );
}

/** 节点 → Surge 系代理行（只要那一行；需要附加段落时用 compileSurgeFamilyEntry）。 */
function compileSurgeFamilyLine(target, rawNode, name) {
  return compiledLine(compileSurgeFamilyEntry(target, rawNode, name));
}

/** 节点 → Quantumult X 的 [server_local] 行；插件的 compile['quantumult-x'] 返回 { type, params }。 */
function compileQuantumultXEntry(rawNode, name) {
  const node = rawNode && typeof rawNode === 'object' ? rawNode : {};
  const { protocol, compile, server, port } = resolveCompile('quantumult-x', node);
  const line = compile({ ...node, protocol, server, port });
  return { line: formatQuantumultXLine(name, { type: line.type, server, port, params: line.params || {} }) };
}

function compileQuantumultXLine(rawNode, name) {
  return compiledLine(compileQuantumultXEntry(rawNode, name));
}

module.exports = {
  compileQuantumultXEntry,
  compileQuantumultXLine,
  compileSurgeFamilyEntry,
  compileSurgeFamilyLine
};
