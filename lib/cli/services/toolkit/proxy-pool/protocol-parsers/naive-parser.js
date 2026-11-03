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
 * NaiveProxy 分享链接：`naive+https://用户名:密码@主机:端口?sni=…#名字`。
 * QUIC 模式（不走 HTTP/2）写 `naive+quic://`。
 */
function parseNaiveLink(link) {
  const cleanLink = String(link || '').trim();
  const scheme = cleanLink.match(/^(naive\+(https|quic)):\/\//i);
  if (!scheme) return null;
  const url = parseUrlSafe(cleanLink);
  if (!url) return null;
  const username = safeDecode(url.username);
  const password = safeDecode(url.password);
  const server = normalizeServerHost(url.hostname);
  const port = Number(url.port || 443);
  if (!username || !password || !server || !Number.isInteger(port) || port <= 0) return null;
  const name = url.hash ? safeDecode(url.hash.slice(1)) : 'Naive Node';
  const country = inferCountryCode(name, server);
  return {
    protocol: 'naive',
    name,
    server,
    port,
    username,
    password,
    quic: scheme[2].toLowerCase() === 'quic' || undefined,
    sni: url.searchParams.get('sni') || undefined,
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    rawUri: cleanLink
  };
}

function encodeNaiveLink(node) {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  const scheme = node.quic === true ? 'naive+quic' : 'naive+https';
  return `${scheme}://${encodeURIComponent(node.username)}:${encodeURIComponent(node.password)}`
    + `@${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  encodeNaiveLink,
  parseNaiveLink
};
