'use strict';

const { parseUrlSafe, inferCountryCode } = require('./base-parser');

/**
 * Parses Trojan (trojan://) links
 * Format: trojan://password@server:port?security=tls&sni=...&type=ws&path=...#name
 */
function parseTrojanLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('trojan://')) return null;

  try {
    const url = parseUrlSafe(cleanLink);
    if (!url) return null;

    const password = url.username;
    const server = url.hostname;
    const port = parseInt(url.port || '443', 10);
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : 'Trojan Node';

    if (!password || !server || !port) return null;

    const params = url.searchParams;
    const network = params.get('type') || 'tcp';
    const sni = params.get('sni') || params.get('peer') || '';
    const path = params.get('path') || '';
    const host = params.get('host') || '';
    const alpn = params.get('alpn') || '';
    const allowInsecure = params.get('allowInsecure') === '1';

    const country = inferCountryCode(name, server);

    return {
      protocol: 'trojan',
      name,
      server,
      port: Number(port),
      password,
      network,
      tls: true,
      sni: sni || host || undefined,
      path: path || undefined,
      host: host || undefined,
      alpn: alpn || undefined,
      allowInsecure,
      countryCode: country.code,
      countryName: country.name,
      countryFlag: country.flag,
      rawUri: cleanLink
    };
  } catch (_e) {
    return null;
  }
}

function encodeTrojanLink(node) {
  const params = new URLSearchParams();
  if (node.network && node.network !== 'tcp') params.set('type', node.network);
  if (node.sni) params.set('sni', node.sni);
  if (node.path) params.set('path', node.path);
  if (node.host) params.set('host', node.host);
  if (node.alpn) params.set('alpn', node.alpn);
  if (node.allowInsecure) params.set('allowInsecure', '1');

  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `trojan://${node.password}@${node.server}:${node.port}${query}${hash}`;
}

module.exports = {
  parseTrojanLink,
  encodeTrojanLink
};
