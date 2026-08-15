'use strict';

const net = require('node:net');

/**
 * Base utility functions for URL/Base64 parsing of proxy sharing links.
 */

function safeBase64Decode(str) {
  if (!str) return '';
  let cleaned = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
  while (cleaned.length % 4 !== 0) {
    cleaned += '=';
  }
  try {
    return Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (_e) {
    return '';
  }
}

function safeBase64Encode(str) {
  if (!str) return '';
  return Buffer.from(String(str), 'utf8').toString('base64');
}

function parseUrlSafe(link) {
  try {
    const url = new URL(link);
    return url;
  } catch (_e) {
    return null;
  }
}

function normalizeServerHost(value) {
  const host = String(value || '').trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    const unwrapped = host.slice(1, -1);
    if (net.isIPv6(unwrapped)) return unwrapped;
  }
  return host;
}

function formatServerHost(value) {
  const host = normalizeServerHost(value);
  return net.isIPv6(host) ? `[${host}]` : host;
}

/**
 * Infer flag / country code / icon from node name or server hostname
 */
function inferCountryCode(name, server = '') {
  const text = `${name} ${server}`.toUpperCase();
  if (/香港|HK|HONG\s*KONG/i.test(text)) return { code: 'HK', name: '香港', flag: '🇭🇰' };
  if (/台湾|TW|TAIWAN/i.test(text)) return { code: 'TW', name: '台湾', flag: '🇨🇳' };
  if (/日本|JP|JAPAN|TOKYO|OSAKA/i.test(text)) return { code: 'JP', name: '日本', flag: '🇯🇵' };
  if (/美国|US|USA|UNITED\s*STATES|AMERICA/i.test(text)) return { code: 'US', name: '美国', flag: '🇺🇸' };
  if (/新加坡|SG|SINGAPORE/i.test(text)) return { code: 'SG', name: '新加坡', flag: '🇸🇬' };
  if (/韩国|KR|KOREA|SEOUL/i.test(text)) return { code: 'KR', name: '韩国', flag: '🇰🇷' };
  if (/英国|UK|GB|UNITED\s*KINGDOM|LONDON/i.test(text)) return { code: 'GB', name: '英国', flag: '🇬🇧' };
  if (/德国|DE|GERMANY|FRANKFURT/i.test(text)) return { code: 'DE', name: '德国', flag: '🇩🇪' };
  if (/法国|FR|FRANCE|PARIS/i.test(text)) return { code: 'FR', name: '法国', flag: '🇫🇷' };
  if (/加拿大|CA|CANADA/i.test(text)) return { code: 'CA', name: '加拿大', flag: '🇨🇦' };
  if (/澳大利亚|AU|AUSTRALIA|SYDNEY/i.test(text)) return { code: 'AU', name: '澳大利亚', flag: '🇦🇺' };
  if (/中国|CN|CHINA|国内/i.test(text)) return { code: 'CN', name: '中国', flag: '🇨🇳' };
  return { code: 'UN', name: '其它', flag: '🌐' };
}

module.exports = {
  safeBase64Decode,
  safeBase64Encode,
  parseUrlSafe,
  normalizeServerHost,
  formatServerHost,
  inferCountryCode
};
