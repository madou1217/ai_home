'use strict';

const net = require('node:net');
const { extractEmbeddedIpv4 } = require('./ip-address-encoding');

const LOCAL_GATEWAY_ADDRESSES = new net.BlockList();
LOCAL_GATEWAY_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_GATEWAY_ADDRESSES.addAddress('0.0.0.0', 'ipv4');
LOCAL_GATEWAY_ADDRESSES.addSubnet('::', 96, 'ipv6');
LOCAL_GATEWAY_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
LOCAL_GATEWAY_ADDRESSES.addAddress('::ffff:0.0.0.0', 'ipv6');

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isLocalGatewayHost(value) {
  const hostname = normalizeHostname(value);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const embeddedIpv4 = extractEmbeddedIpv4(hostname);
  if (embeddedIpv4 && isLocalGatewayHost(embeddedIpv4)) return true;
  const family = net.isIP(hostname);
  if (!family) return false;
  return LOCAL_GATEWAY_ADDRESSES.check(hostname, family === 4 ? 'ipv4' : 'ipv6');
}

function isCurrentImageGatewayUrl(value, serverPort) {
  const expectedPort = Number(serverPort);
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) return false;
  try {
    const url = new URL(String(value || ''));
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return targetPort === expectedPort && isLocalGatewayHost(url.hostname);
  } catch (_error) {
    return false;
  }
}

module.exports = {
  isCurrentImageGatewayUrl,
  __private: {
    isLocalGatewayHost,
    normalizeHostname
  }
};
