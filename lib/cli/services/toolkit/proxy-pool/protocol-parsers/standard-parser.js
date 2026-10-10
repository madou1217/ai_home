'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');

/**
 * Parses standard SOCKS5 (socks5://) and HTTP/HTTPS (http:// or https://) proxy links
 * Format: socks5://user:pass@server:port#name or http://user:pass@server:port#name
 */
function parseStandardProxyLink(link) {
  const cleanLink = String(link || '').trim();
  const isSocks = cleanLink.startsWith('socks5://') || cleanLink.startsWith('socks://');
  const isHttp = cleanLink.startsWith('http://') || cleanLink.startsWith('https://');

  if (!isSocks && !isHttp) return null;

  try {
    const url = parseUrlSafe(cleanLink);
    // 代理地址没有路径：带路径的是订阅、规则集之类的资源链接（例如 QX 配置里的远程资源行）。
    if (!url || (url.pathname && url.pathname !== '/')) return null;

    const protocol = isSocks ? 'socks5' : (cleanLink.startsWith('https://') ? 'https' : 'http');
    const username = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    const server = normalizeServerHost(url.hostname);
    const defaultPort = protocol === 'https' ? 443 : (protocol === 'http' ? 80 : 1080);
    const port = parseInt(url.port || String(defaultPort), 10);
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : `${protocol.toUpperCase()} Node`;

    if (!server || !port) return null;

    const country = inferCountryCode(name, server);

    return {
      protocol,
      name,
      server,
      port: Number(port),
      username: username || undefined,
      password: password || undefined,
      tls: protocol === 'https',
      countryCode: country.code,
      countryName: country.name,
      countryFlag: country.flag,
      rawUri: cleanLink
    };
  } catch (_e) {
    return null;
  }
}

function encodeStandardProxyLink(node) {
  let auth = '';
  if (node.username || node.password) {
    auth = `${encodeURIComponent(node.username || '')}:${encodeURIComponent(node.password || '')}@`;
  }
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `${node.protocol}://${auth}${formatServerHost(node.server)}:${node.port}${hash}`;
}

module.exports = {
  parseStandardProxyLink,
  encodeStandardProxyLink
};
