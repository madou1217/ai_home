'use strict';

const net = require('node:net');

function normalizeIpAddress(value) {
  return String(value || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
}

function ipv4FromHexWords(highWord, lowWord) {
  const high = Number.parseInt(highWord, 16);
  const low = Number.parseInt(lowWord, 16);
  if (!Number.isInteger(high) || high < 0 || high > 0xffff
    || !Number.isInteger(low) || low < 0 || low > 0xffff) return '';
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function extractEmbeddedIpv4(value) {
  const address = normalizeIpAddress(value);
  if (net.isIP(address) !== 6) return '';
  const mapped = address.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i);
  if (mapped) return mapped[1] || ipv4FromHexWords(mapped[2], mapped[3]);
  const compatible = address.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (compatible) return ipv4FromHexWords(compatible[1], compatible[2]);
  const sixToFour = address.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i);
  return sixToFour ? ipv4FromHexWords(sixToFour[1], sixToFour[2]) : '';
}

module.exports = {
  extractEmbeddedIpv4,
  ipv4FromHexWords,
  normalizeIpAddress
};
