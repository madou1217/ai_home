'use strict';

const { inferCountryCode, normalizeServerHost, safeBase64Decode, safeBase64Encode } = require('./base-parser');

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
    const server = normalizeServerHost(data.add);
    const port = parseInt(data.port, 10);
    const uuid = data.id;

    if (!server || !port || !uuid) return null;

    const country = inferCountryCode(name, server);
    const network = String(data.net || 'tcp').trim().toLowerCase() || 'tcp';
    const headerType = String(data.type || 'none').trim().toLowerCase();
    // V2RayN 约定：grpc 的 serviceName 放在 path；tcp + type=http 表示 HTTP/1.1 伪装。
    const resolvedNetwork = network === 'tcp' && headerType === 'http' ? 'http' : network;

    return {
      protocol: 'vmess',
      name,
      server,
      port: Number(port),
      uuid,
      alterId: parseInt(data.aid || 0, 10),
      cipher: data.scy || 'auto',
      network: resolvedNetwork,
      type: data.type || 'none',
      host: data.host || '',
      path: network === 'grpc' ? '' : data.path || '',
      serviceName: network === 'grpc' ? data.serviceName || data.path || undefined : undefined,
      tls: data.tls === true || String(data.tls || '').toLowerCase() === 'tls',
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
    add: normalizeServerHost(node.server),
    port: node.port,
    id: node.uuid,
    aid: node.alterId || 0,
    scy: node.cipher || 'auto',
    net: node.network === 'http' ? 'tcp' : node.network || 'tcp',
    type: node.network === 'http' ? 'http' : node.type || 'none',
    host: node.host || '',
    path: node.network === 'grpc' ? node.serviceName || '' : node.path || '',
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
