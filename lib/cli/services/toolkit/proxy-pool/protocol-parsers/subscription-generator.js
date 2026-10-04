'use strict';

const { compileMihomoConfig } = require('../cores/mihomo/config-compiler');
const { SUPPORTED_PROTOCOLS, getProtocolPlugin } = require('../protocols');

// 订阅导出只编码受支持的运行协议（旧版 hysteria 不导出）。
function encodeNode(node) {
  const protocol = node?.protocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) return '';
  return getProtocolPlugin(protocol).encode(node);
}

function generateMihomoYaml(nodes = [], options = {}) {
  return compileMihomoConfig({
    mixedPort: options.mixedPort,
    nodes,
    routing: options.routing || { mode: 'direct', rules: [] },
    dedicatedPorts: { mappings: {} }
  }, { includeController: false }).content;
}

function generateBase64Subscription(nodes = []) {
  const content = nodes.map(encodeNode).filter(Boolean).join('\n');
  return Buffer.from(content, 'utf8').toString('base64');
}

function generateSingboxJson() {
  const error = new Error('unsupported_export_format');
  error.code = 'unsupported_export_format';
  throw error;
}

module.exports = {
  generateBase64Subscription,
  generateMihomoYaml,
  generateSingboxJson
};
