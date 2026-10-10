'use strict';

const { encodeStandardProxyLink, parseStandardProxyLink } = require('../protocol-parsers/standard-parser');

module.exports = Object.freeze({
  id: 'socks5',
  capability: 'proxy-pool.protocol',
  name: 'SOCKS5',
  protocols: Object.freeze(['socks5']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['socks5', 'socks']),
  parse: parseStandardProxyLink,
  encode: encodeStandardProxyLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'socks5';
      if (node.username) proxy.username = String(node.username);
      if (node.password) proxy.password = String(node.password);
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = { ...base, type: 'socks', version: '5' };
      if (node.username) outbound.username = String(node.username);
      if (node.password) outbound.password = String(node.password);
      return outbound;
    }
  })
});
