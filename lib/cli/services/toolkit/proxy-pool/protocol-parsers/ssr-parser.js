'use strict';

const { inferCountryCode, normalizeServerHost, safeBase64Decode } = require('./base-parser');

function base64Url(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

/**
 * ShadowsocksR 分享链接：ssr://BASE64URL(server:port:protocol:method:obfs:BASE64URL(password)/?obfsparam=…&protoparam=…&remarks=…&group=…)，
 * 查询参数的值也是 base64url。从右往左切分，裸写的 IPv6 服务器也能解析。
 */
function parseSSRLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('ssr://')) return null;
  const decoded = safeBase64Decode(cleanLink.slice(6).replace(/#.*$/, '')).trim();
  const queryIndex = decoded.indexOf('?');
  const main = (queryIndex === -1 ? decoded : decoded.slice(0, queryIndex)).replace(/\/+$/, '');
  const parts = main.split(':');
  if (parts.length < 6) return null;
  const [port, ssrProtocol, cipher, ssrObfs, passwordBase64] = parts.slice(-5);
  const server = normalizeServerHost(parts.slice(0, -5).join(':'));
  const password = safeBase64Decode(passwordBase64);
  if (!server || !/^\d{1,5}$/.test(port) || Number(port) <= 0 || !cipher || !password) return null;
  const params = new URLSearchParams(queryIndex === -1 ? '' : decoded.slice(queryIndex + 1));
  const param = (key) => safeBase64Decode(params.get(key) || '') || undefined;
  const name = param('remarks') || 'ShadowsocksR Node';
  const country = inferCountryCode(name, server);
  return {
    protocol: 'shadowsocksr',
    name,
    server,
    port: Number(port),
    cipher,
    password,
    ssrProtocol: ssrProtocol || undefined,
    ssrProtocolParam: param('protoparam'),
    ssrObfs: ssrObfs || undefined,
    ssrObfsParam: param('obfsparam'),
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    rawUri: cleanLink
  };
}

function encodeSSRLink(node) {
  const main = [
    normalizeServerHost(node.server),
    node.port,
    node.ssrProtocol || 'origin',
    node.cipher,
    node.ssrObfs || 'plain',
    base64Url(node.password || '')
  ].join(':');
  const params = [
    ['obfsparam', node.ssrObfsParam],
    ['protoparam', node.ssrProtocolParam],
    ['remarks', node.name]
  ].filter(([, value]) => value).map(([key, value]) => `${key}=${base64Url(value)}`);
  return `ssr://${base64Url(`${main}/?${params.join('&')}`)}`;
}

module.exports = {
  encodeSSRLink,
  parseSSRLink
};
