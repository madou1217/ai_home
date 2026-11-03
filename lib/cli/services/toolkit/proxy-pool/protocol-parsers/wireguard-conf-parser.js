'use strict';

// WireGuard 配置文件（wg-quick / 官方客户端导出的 .conf）→ 节点：[Interface] 给本机私钥与地址，
// 每个 [Peer] 一个节点（通常只有一个）。只有一种协议，字段映射直接写在这里。

const { buildImportedNode, importError } = require('./imported-node');
const { splitAddresses, splitWireGuardEndpoint } = require('./wireguard-parser');

const SECTION_PATTERN = /^\s*\[(interface|peer)\]\s*$/i;

/** 按段读取 key = value（段名不区分大小写，键名转小写；# 与 ; 开头的是注释）。 */
function readSections(text) {
  const sections = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(SECTION_PATTERN);
    if (header) {
      current = { kind: header[1].toLowerCase(), values: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf('=');
    if (!current || separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    // 同一个键可以写多行（Address、AllowedIPs），按逗号拼起来。
    const value = line.slice(separator + 1).trim();
    current.values[key] = current.values[key] ? `${current.values[key]}, ${value}` : value;
  }
  return sections;
}

/** 不是 WireGuard 配置（没有带私钥的 [Interface] 和 [Peer]）时返回 null。 */
function parseWireGuardConfDetailed(text, { name = '' } = {}) {
  const sections = readSections(text);
  const iface = sections.find((section) => section.kind === 'interface');
  const peers = sections.filter((section) => section.kind === 'peer');
  if (!iface || !iface.values.privatekey || !peers.length) return null;

  const plugin = require('../protocols').getProtocolPlugin('wireguard');
  const nodes = [];
  const skippedNodes = [];
  peers.forEach((peer, index) => {
    const label = name ? (peers.length > 1 ? `${name} ${index + 1}` : name) : '';
    try {
      if (!peer.values.publickey) throw importError('missing_required_proxy_field_publicKey');
      const { address: server, port } = splitWireGuardEndpoint(peer.values.endpoint);
      const mtu = Number(iface.values.mtu);
      nodes.push(buildImportedNode({
        plugin,
        name: label || `WireGuard ${server}`,
        server,
        port,
        fields: {
          privateKey: iface.values.privatekey,
          publicKey: peer.values.publickey,
          presharedKey: peer.values.presharedkey || undefined,
          ...splitAddresses(iface.values.address),
          mtu: Number.isInteger(mtu) && mtu > 0 ? mtu : undefined
        }
      }));
    } catch (error) {
      skippedNodes.push({ nodeId: null, name: label || null, reason: error.code || error.message });
    }
  });
  return { nodes, skippedNodes, warnings: [] };
}

module.exports = {
  parseWireGuardConfDetailed
};
