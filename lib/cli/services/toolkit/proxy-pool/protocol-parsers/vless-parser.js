'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');

/**
 * Parses VLESS (vless://) links (Xray / Sing-box standard)
 * Format: vless://uuid@server:port?type=ws&security=reality&pbk=...&sni=...&path=...#name
 */
function parseVLESSLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('vless://')) return null;

  try {
    const url = parseUrlSafe(cleanLink);
    if (!url) return null;

    const uuid = url.username;
    const server = normalizeServerHost(url.hostname);
    const port = parseInt(url.port || '443', 10);
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : 'VLESS Node';

    if (!uuid || !server || !port) return null;

    const params = url.searchParams;
    const network = params.get('type') || 'tcp';
    const security = params.get('security') || 'none';
    const flow = params.get('flow') || '';
    const sni = params.get('sni') || '';
    const pbk = params.get('pbk') || '';
    const sid = params.get('sid') || '';
    const fp = params.get('fp') || '';
    const path = params.get('path') || '';
    const host = params.get('host') || '';
    const serviceName = params.get('serviceName') || '';

    const country = inferCountryCode(name, server);

    return {
      protocol: 'vless',
      name,
      server,
      port: Number(port),
      uuid,
      flow: flow || undefined,
      network,
      security,
      sni: sni || host || undefined,
      publicKey: pbk || undefined,
      shortId: sid || undefined,
      fingerprint: fp || undefined,
      path: path || undefined,
      host: host || undefined,
      serviceName: serviceName || undefined,
      tls: security === 'tls' || security === 'reality',
      countryCode: country.code,
      countryName: country.name,
      countryFlag: country.flag,
      rawUri: cleanLink
    };
  } catch (_e) {
    return null;
  }
}

function encodeVLESSLink(node) {
  const params = new URLSearchParams();
  if (node.network) params.set('type', node.network);
  if (node.security) params.set('security', node.security);
  if (node.flow) params.set('flow', node.flow);
  if (node.sni) params.set('sni', node.sni);
  if (node.publicKey) params.set('pbk', node.publicKey);
  if (node.shortId) params.set('sid', node.shortId);
  if (node.fingerprint) params.set('fp', node.fingerprint);
  if (node.path) params.set('path', node.path);
  if (node.host) params.set('host', node.host);
  if (node.serviceName) params.set('serviceName', node.serviceName);

  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `vless://${node.uuid}@${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  parseVLESSLink,
  encodeVLESSLink
};
