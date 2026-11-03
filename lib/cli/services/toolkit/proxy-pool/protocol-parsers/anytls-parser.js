'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

/** AnyTLS 分享链接：anytls://password@host:port?sni=…&insecure=1&alpn=…&fp=chrome#name */
function parseAnyTlsLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('anytls://')) return null;
  const url = parseUrlSafe(cleanLink);
  if (!url) return null;
  const password = safeDecode(url.username);
  const server = normalizeServerHost(url.hostname);
  const port = Number(url.port || 443);
  if (!password || !server || !Number.isInteger(port) || port <= 0) return null;
  const params = url.searchParams;
  const name = url.hash ? safeDecode(url.hash.slice(1)) : 'AnyTLS Node';
  const country = inferCountryCode(name, server);
  return {
    protocol: 'anytls',
    name,
    server,
    port,
    password,
    tls: true,
    sni: params.get('sni') || params.get('peer') || undefined,
    alpn: params.get('alpn') || undefined,
    fingerprint: params.get('fp') || undefined,
    allowInsecure: ['1', 'true'].includes(String(params.get('insecure') || '').toLowerCase()) || undefined,
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    rawUri: cleanLink
  };
}

function encodeAnyTlsLink(node) {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn));
  if (node.fingerprint) params.set('fp', node.fingerprint);
  if (node.allowInsecure) params.set('insecure', '1');
  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `anytls://${encodeURIComponent(node.password)}@${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  encodeAnyTlsLink,
  parseAnyTlsLink
};
