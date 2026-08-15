'use strict';

const { safeBase64Decode, safeBase64Encode, inferCountryCode } = require('./base-parser');

/**
 * Parses VMess (vmess://) links (V2RayN JSON Base64 standard)
 * Example JSON:
 * {
 *   "v": "2", "ps": "Name", "add": "server.com", "port": 443, "id": "uuid",
 *   "aid": 0, "scy": "auto", "net": "ws", "type": "none", "host": "host.com",
 *   "path": "/path", "tls": "tls", "sni": "host.com", "alpn": ""
 * }
 */
function parseVMessLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('vmess://')) return null;

  try {
    const raw = cleanLink.slice(8);
    const decoded = safeBase64Decode(raw);
    if (!decoded) return null;

    const data = JSON.parse(decoded);
    const name = data.ps || 'VMess Node';
    const server = data.add;
    const port = parseInt(data.port, 10);
    const uuid = data.id;

    if (!server || !port || !uuid) return null;

    const country = inferCountryCode(name, server);

    return {
      protocol: 'vmess',
      name,
      server,
      port: Number(port),
      uuid,
      alterId: parseInt(data.aid || 0, 10),
      cipher: data.scy || 'auto',
      network: data.net || 'tcp',
      type: data.type || 'none',
      host: data.host || '',
      path: data.path || '',
      tls: data.tls === 'tls' || Boolean(data.tls),
      sni: data.sni || data.host || '',
      alpn: data.alpn || '',
      countryCode: country.code,
      countryName: country.name,
      countryFlag: country.flag,
      rawUri: cleanLink
    };
  } catch (_e) {
    return null;
  }
}

function encodeVMessLink(node) {
  const data = {
    v: '2',
    ps: node.name || 'VMess Node',
    add: node.server,
    port: node.port,
    id: node.uuid,
    aid: node.alterId || 0,
    scy: node.cipher || 'auto',
    net: node.network || 'tcp',
    type: node.type || 'none',
    host: node.host || '',
    path: node.path || '',
    tls: node.tls ? 'tls' : '',
    sni: node.sni || node.host || '',
    alpn: node.alpn || ''
  };

  return `vmess://${safeBase64Encode(JSON.stringify(data))}`;
}

module.exports = {
  parseVMessLink,
  encodeVMessLink
};
