'use strict';

const { compileMihomoConfig } = require('../mihomo-config-compiler');
const { encodeSSLink } = require('./ss-parser');
const { encodeVMessLink } = require('./vmess-parser');
const { encodeVLESSLink } = require('./vless-parser');
const { encodeTrojanLink } = require('./trojan-parser');
const { encodeHysteriaLink } = require('./hysteria-parser');
const { encodeStandardProxyLink } = require('./standard-parser');

function encodeNode(node) {
  switch (node?.protocol) {
    case 'shadowsocks': return encodeSSLink(node);
    case 'vmess': return encodeVMessLink(node);
    case 'vless': return encodeVLESSLink(node);
    case 'trojan': return encodeTrojanLink(node);
    case 'hysteria2': return encodeHysteriaLink(node);
    case 'socks5':
    case 'http':
    case 'https': return encodeStandardProxyLink(node);
    default: return '';
  }
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
