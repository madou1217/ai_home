'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function positive(value) {
  const number = Number(String(value || '').match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * Hysteria（v1）分享链接：
 * hysteria://host:port?protocol=udp&auth=…&peer=sni&insecure=1&upmbps=…&downmbps=…&alpn=…&obfs=xplus&obfsParam=…#name
 */
function parseHysteria1Link(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('hysteria://')) return null;
  const url = parseUrlSafe(cleanLink);
  if (!url) return null;
  const server = normalizeServerHost(url.hostname);
  const port = Number(url.port || 443);
  if (!server || !Number.isInteger(port) || port <= 0) return null;
  const params = url.searchParams;
  const name = url.hash ? safeDecode(url.hash.slice(1)) : 'Hysteria Node';
  const country = inferCountryCode(name, server);
  const insecure = ['1', 'true'].includes(String(params.get('insecure') || '').toLowerCase());
  return {
    protocol: 'hysteria',
    name,
    server,
    port,
    authStr: params.get('auth') || (url.username ? safeDecode(url.username) : undefined),
    hysteriaProtocol: params.get('protocol') || undefined,
    tls: true,
    sni: params.get('peer') || params.get('sni') || undefined,
    allowInsecure: insecure || undefined,
    alpn: params.get('alpn') || undefined,
    obfs: params.get('obfsParam') || params.get('obfs-password') || undefined,
    upMbps: positive(params.get('upmbps') || params.get('up')),
    downMbps: positive(params.get('downmbps') || params.get('down')),
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    rawUri: cleanLink
  };
}

function encodeHysteria1Link(node) {
  const params = new URLSearchParams();
  if (node.hysteriaProtocol) params.set('protocol', node.hysteriaProtocol);
  if (node.authStr) params.set('auth', node.authStr);
  if (node.sni) params.set('peer', node.sni);
  if (node.allowInsecure || node.insecure) params.set('insecure', '1');
  if (node.upMbps) params.set('upmbps', String(node.upMbps));
  if (node.downMbps) params.set('downmbps', String(node.downMbps));
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn));
  if (node.obfs) {
    params.set('obfs', 'xplus');
    params.set('obfsParam', node.obfs);
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `hysteria://${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  encodeHysteria1Link,
  parseHysteria1Link
};
