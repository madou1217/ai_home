'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const {
  isValidPort,
  normalizeProtocol,
  SUPPORTED_PROTOCOLS
} = require('../../proxy-protocol-contract');
const { getProtocolPlugin } = require('../../protocols');
const { requiredString } = require('./proxy-fields');

function yamlScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_yaml_number');
    return String(value);
  }
  return JSON.stringify(String(value));
}

function yamlKey(key) {
  const text = String(key);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : JSON.stringify(text);
}

/** 最小 YAML 输出（mihomo 配置用）：字符串一律 JSON 引号，键名非安全字符时加引号。 */
function emitYaml(value, indent = 0) {
  const padding = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${padding}[]`;
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        const nested = emitYaml(item, indent + 2);
        const nestedLines = nested.split('\n');
        return `${padding}- ${nestedLines[0].trimStart()}${nestedLines.length > 1 ? `\n${nestedLines.slice(1).join('\n')}` : ''}`;
      }
      return `${padding}- ${yamlScalar(item)}`;
    }).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return `${padding}{}`;
    return entries.map(([key, item]) => {
      if (item !== null && typeof item === 'object') {
        if ((Array.isArray(item) && item.length === 0) || (!Array.isArray(item) && Object.keys(item).length === 0)) {
          return `${padding}${yamlKey(key)}: ${Array.isArray(item) ? '[]' : '{}'}`;
        }
        return `${padding}${yamlKey(key)}:\n${emitYaml(item, indent + 2)}`;
      }
      return `${padding}${yamlKey(key)}: ${yamlScalar(item)}`;
    }).join('\n');
  }
  return `${padding}${yamlScalar(value)}`;
}

/**
 * 把节点编译成 mihomo proxy 条目：通用字段在这里校验，协议字段交给协议插件的 compile.mihomo。
 * 订阅聚合器用它渲染 Clash 订阅，节点库用它校验导入的节点能被客户端使用。
 */
function compileMihomoProxy(node, name) {
  const protocol = normalizeProtocol(node.protocol);
  const plugin = getProtocolPlugin(protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol) || !plugin || typeof plugin.compile?.mihomo !== 'function') {
    throw new Error(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = normalizeServerHost(requiredString(node, 'server'));
  if (!server) throw new Error('missing_required_proxy_field_server');
  if (!isValidPort(node.port)) throw new Error('invalid_proxy_port');
  return plugin.compile.mihomo({ ...node, protocol }, { name, server, port: Number(node.port) });
}

module.exports = {
  compileMihomoProxy,
  emitYaml
};
