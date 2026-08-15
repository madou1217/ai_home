'use strict';

const { safeBase64Decode, safeBase64Encode, parseUrlSafe, inferCountryCode } = require('./base-parser');

/**
 * Parses Shadowsocks (ss://) links (SIP002 and legacy base64 format)
 * SIP002: ss://BASE64(method:password)@server:port#name or ss://BASE64(method:password@server:port)#name
 */
function parseSSLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('ss://')) return null;

  try {
    const raw = cleanLink.slice(5);
    const hashIndex = raw.indexOf('#');
    let mainPart = hashIndex !== -1 ? raw.slice(0, hashIndex) : raw;
    let tag = hashIndex !== -1 ? decodeURIComponent(raw.slice(hashIndex + 1)) : 'Shadowsocks Node';

    let method = 'aes-256-gcm';
    let password = '';
    let server = '';
    let port = 8388;
    let plugin = '';
    let pluginOpts = '';

    if (mainPart.includes('@')) {
      // SIP002 format: ss://BASE64(method:password)@server:port/?plugin=...#tag
      const [userinfoB64, hostPortAndQuery] = mainPart.split('@');
      const decodedUserinfo = safeBase64Decode(userinfoB64) || userinfoB64;
      const colonIndex = decodedUserinfo.indexOf(':');
      if (colonIndex !== -1) {
        method = decodedUserinfo.slice(0, colonIndex);
        password = decodedUserinfo.slice(colonIndex + 1);
      }

      let hostPort = hostPortAndQuery;
      if (hostPortAndQuery.includes('/?')) {
        const [hp, query] = hostPortAndQuery.split('/?');
        hostPort = hp;
        const params = new URLSearchParams(query);
        if (params.has('plugin')) {
          const rawPlugin = params.get('plugin');
          const [pName, ...pOpts] = rawPlugin.split(';');
          plugin = pName;
          pluginOpts = pOpts.join(';');
        }
      }

      const lastColon = hostPort.lastIndexOf(':');
      if (lastColon !== -1) {
        server = hostPort.slice(0, lastColon);
        port = parseInt(hostPort.slice(lastColon + 1), 10);
      } else {
        server = hostPort;
      }
    } else {
      // Legacy format: ss://BASE64(method:password@server:port)
      const decoded = safeBase64Decode(mainPart);
      if (decoded.includes('@')) {
        const [userinfo, hostPort] = decoded.split('@');
        const colonIndex = userinfo.indexOf(':');
        if (colonIndex !== -1) {
          method = userinfo.slice(0, colonIndex);
          password = userinfo.slice(colonIndex + 1);
        }
        const lastColon = hostPort.lastIndexOf(':');
        if (lastColon !== -1) {
          server = hostPort.slice(0, lastColon);
          port = parseInt(hostPort.slice(lastColon + 1), 10);
        }
      }
    }

    if (!server || !port) return null;

    const country = inferCountryCode(tag, server);

    return {
      protocol: 'shadowsocks',
      name: tag,
      server,
      port: Number(port),
      password,
      cipher: method,
      plugin: plugin || undefined,
      pluginOpts: pluginOpts || undefined,
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
  const userinfo = `${node.cipher || 'aes-256-gcm'}:${node.password || ''}`;
  const userinfoB64 = safeBase64Encode(userinfo);
  let link = `ss://${userinfoB64}@${node.server}:${node.port}`;
  if (node.plugin) {
    link += `/?plugin=${encodeURIComponent(node.plugin + (node.pluginOpts ? ';' + node.pluginOpts : ''))}`;
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
