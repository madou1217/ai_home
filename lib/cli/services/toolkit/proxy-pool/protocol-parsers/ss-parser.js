'use strict';

const {
  formatServerHost,
  inferCountryCode,
  normalizeServerHost,
  safeBase64Decode,
  safeBase64Encode
} = require('./base-parser');
const { canonicalShadowsocksPlugin, toSip003Plugin } = require('../shadowsocks-plugin');

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function splitMethodPassword(text) {
  const colon = String(text || '').indexOf(':');
  if (colon <= 0) return null;
  const method = text.slice(0, colon);
  return /^[A-Za-z0-9_-]+$/.test(method) ? { method, password: text.slice(colon + 1) } : null;
}

// SIP002 的 userinfo 是 base64url(method:password)；AEAD-2022 与不少客户端改用百分号编码的明文。
// base64 字母表里没有冒号，所以解码后带冒号的一定是明文形式。
function decodeUserinfo(userinfo) {
  const plain = splitMethodPassword(safeDecodeURIComponent(userinfo));
  if (plain) return plain;
  return splitMethodPassword(safeBase64Decode(userinfo));
}

function parseHostPort(text) {
  const value = String(text || '').trim();
  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) return { server: ipv6[1], port: Number(ipv6[2]) };
  const colon = value.lastIndexOf(':');
  if (colon === -1) return null;
  return { server: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
}

function parsePluginParam(query) {
  const rawPlugin = new URLSearchParams(query).get('plugin');
  if (!rawPlugin) return {};
  const [plugin, ...options] = rawPlugin.split(';');
  return { plugin: plugin || undefined, pluginOpts: options.join(';') || undefined };
}

/**
 * Shadowsocks 分享链接：
 * - SIP002：ss://userinfo@host:port[/][?plugin=...]#name（userinfo 为 base64url 或百分号编码明文）
 * - 旧格式：ss://BASE64(method:password@host:port)[?plugin=...]#name
 */
function parseSSLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('ss://')) return null;

  try {
    const raw = cleanLink.slice(5);
    const hashIndex = raw.indexOf('#');
    const mainPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
    const tag = hashIndex === -1 ? 'Shadowsocks Node' : safeDecodeURIComponent(raw.slice(hashIndex + 1)) || 'Shadowsocks Node';
    const queryIndex = mainPart.indexOf('?');
    const body = (queryIndex === -1 ? mainPart : mainPart.slice(0, queryIndex)).replace(/\/+$/, '');
    const query = queryIndex === -1 ? '' : mainPart.slice(queryIndex + 1);

    let credentials;
    let endpoint;
    const at = body.lastIndexOf('@');
    if (at !== -1) {
      credentials = decodeUserinfo(body.slice(0, at));
      endpoint = parseHostPort(body.slice(at + 1));
    } else {
      const decoded = safeBase64Decode(body);
      const legacyAt = decoded.lastIndexOf('@');
      if (legacyAt === -1) return null;
      credentials = splitMethodPassword(decoded.slice(0, legacyAt));
      endpoint = parseHostPort(decoded.slice(legacyAt + 1));
    }
    if (!credentials || !endpoint) return null;

    const server = normalizeServerHost(endpoint.server);
    if (!server || !Number.isInteger(endpoint.port) || endpoint.port <= 0) return null;
    const country = inferCountryCode(tag, server);
    const { plugin, pluginOpts } = parsePluginParam(query);

    return {
      protocol: 'shadowsocks',
      name: tag,
      server,
      port: endpoint.port,
      password: credentials.password,
      cipher: credentials.method,
      plugin,
      pluginOpts,
      countryCode: country.code,
      countryName: country.name,
      countryFlag: country.flag,
      rawUri: cleanLink
    };
  } catch (_e) {
    return null;
  }
}

function encodeSSLink(node) {
  const method = node.cipher || 'aes-256-gcm';
  // AEAD-2022 的密码本身是 base64，SIP002 要求用百分号编码的明文 userinfo。
  const userinfo = method.startsWith('2022-')
    ? `${encodeURIComponent(method)}:${encodeURIComponent(node.password || '')}`
    : safeBase64Encode(`${method}:${node.password || ''}`);
  let link = `ss://${userinfo}@${formatServerHost(node.server)}:${node.port}`;
  // 分享链接用 SIP003 写法（Clash 的 obfs + {mode, host} 也换成 obfs-local + obfs=…）。
  const plugin = toSip003Plugin(canonicalShadowsocksPlugin(node));
  if (plugin) {
    link += `/?plugin=${encodeURIComponent(plugin.plugin + (plugin.options ? `;${plugin.options}` : ''))}`;
  }
  if (node.name) {
    link += `#${encodeURIComponent(node.name)}`;
  }
  return link;
}

module.exports = {
  parseSSLink,
  encodeSSLink
};
