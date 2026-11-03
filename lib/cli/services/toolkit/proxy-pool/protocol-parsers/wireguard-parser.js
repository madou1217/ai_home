'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');
const { importError } = require('./imported-node');

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

/** WireGuard 对端 Endpoint：host:port，IPv6 写在方括号里（.conf 与 Xray 配置共用）。 */
function splitWireGuardEndpoint(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^\[([^\]]+)\]:(\d+)$/) || text.match(/^([^:\s]+):(\d+)$/);
  if (!match) throw importError('invalid_wireguard_endpoint');
  return { address: match[1], port: Number(match[2]) };
}

/** 本机地址列表（a.b.c.d/32, fd00::2/128）→ { ip, ipv6 }（去掉单主机前缀长度）。 */
function splitAddresses(value) {
  const result = {};
  for (const raw of String(value || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const address = raw.replace(/\/(?:32|128)$/, '');
    if (address.includes(':')) result.ipv6 = result.ipv6 || address;
    else result.ip = result.ip || address;
  }
  return result;
}

/**
 * WireGuard 分享链接（v2rayN / Hiddify 写法）：
 * wireguard://privateKey@host:port?publickey=…&address=10.0.0.2/32,fd00::2/128&mtu=1280&reserved=1,2,3#name（也认 wg://）
 */
function parseWireGuardLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('wireguard://') && !cleanLink.startsWith('wg://')) return null;
  const url = parseUrlSafe(cleanLink);
  if (!url) return null;
  const params = url.searchParams;
  const privateKey = safeDecode(url.username) || params.get('privatekey') || params.get('private_key');
  const publicKey = params.get('publickey') || params.get('public_key') || params.get('publicKey') || params.get('pubkey');
  const server = normalizeServerHost(url.hostname);
  const port = Number(url.port || 51820);
  if (!privateKey || !publicKey || !server || !Number.isInteger(port) || port <= 0) return null;
  const name = url.hash ? safeDecode(url.hash.slice(1)) : 'WireGuard Node';
  const country = inferCountryCode(name, server);
  const mtu = Number(params.get('mtu'));
  return {
    protocol: 'wireguard',
    name,
    server,
    port,
    privateKey,
    publicKey,
    presharedKey: params.get('presharedkey') || params.get('preshared_key') || params.get('psk') || undefined,
    ...splitAddresses(params.get('address') || params.get('ip')),
    mtu: Number.isInteger(mtu) && mtu > 0 ? mtu : undefined,
    reserved: params.get('reserved') || undefined,
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    rawUri: cleanLink
  };
}

function encodeWireGuardLink(node) {
  const params = new URLSearchParams();
  params.set('publickey', node.publicKey);
  const addresses = [node.ip ? `${node.ip}/32` : '', node.ipv6 ? `${node.ipv6}/128` : ''].filter(Boolean);
  if (addresses.length) params.set('address', addresses.join(','));
  if (node.presharedKey) params.set('presharedkey', node.presharedKey);
  if (node.mtu) params.set('mtu', String(node.mtu));
  if (node.reserved) params.set('reserved', String(node.reserved));
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `wireguard://${encodeURIComponent(node.privateKey)}@${formatServerHost(node.server)}:${node.port}?${params.toString()}${hash}`;
}

module.exports = {
  encodeWireGuardLink,
  parseWireGuardLink,
  splitAddresses,
  splitWireGuardEndpoint
};
