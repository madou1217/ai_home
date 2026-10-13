'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

/**
 * TUIC v5 分享链接：tuic://uuid:password@host:port?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=…&allow_insecure=1#name
 * v4 只有 token，没有公认的链接写法（各家客户端的 tuic:// 实现不一致），只从配置导入。
 */
function parseTuicLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('tuic://')) return null;
  const url = parseUrlSafe(cleanLink);
  if (!url) return null;
  const uuid = safeDecode(url.username);
  const password = safeDecode(url.password);
  const server = normalizeServerHost(url.hostname);
  const port = Number(url.port || 443);
  if (!uuid || !password || !server || !Number.isInteger(port) || port <= 0) return null;
  const params = url.searchParams;
  const name = url.hash ? safeDecode(url.hash.slice(1)) : 'TUIC Node';
  const country = inferCountryCode(name, server);
  const insecure = ['1', 'true'].includes(String(params.get('allow_insecure') || params.get('insecure') || '').toLowerCase());
  return {
    protocol: 'tuic',
    name,
    server,
    port,
    uuid,
    password,
    congestionControl: params.get('congestion_control') || params.get('congestion-control') || undefined,
    udpRelayMode: params.get('udp_relay_mode') || params.get('udp-relay-mode') || undefined,
    tls: true,
    sni: params.get('sni') || undefined,
    alpn: params.get('alpn') || undefined,
    allowInsecure: insecure || undefined,
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    rawUri: cleanLink
  };
}

function encodeTuicLink(node) {
  const params = new URLSearchParams();
  if (node.congestionControl) params.set('congestion_control', node.congestionControl);
  if (node.udpRelayMode) params.set('udp_relay_mode', node.udpRelayMode);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn));
  if (node.sni) params.set('sni', node.sni);
  if (node.allowInsecure || node.insecure) params.set('allow_insecure', '1');
  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `tuic://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password)}@${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  encodeTuicLink,
  parseTuicLink
};
