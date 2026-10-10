'use strict';

const { encodeStandardProxyLink, parseStandardProxyLink } = require('../protocol-parsers/standard-parser');
const { buildTls } = require('../cores/sing-box/outbound-fields');

module.exports = Object.freeze({
  id: 'http',
  capability: 'proxy-pool.protocol',
  name: 'HTTP / HTTPS',
  protocols: Object.freeze(['http', 'https']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['http', 'https']),
  fields: Object.freeze({
    username: 'string',
    password: 'string',
    tls: 'boolean',
    sni: 'string',
    allowInsecure: 'boolean'
  }),
  parse: parseStandardProxyLink,
  encode: encodeStandardProxyLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'http';
      if (node.protocol === 'https') proxy.tls = true;
      if (node.username) proxy.username = String(node.username);
      if (node.password) proxy.password = String(node.password);
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = { ...base, type: 'http' };
      if (node.username) outbound.username = String(node.username);
      if (node.password) outbound.password = String(node.password);
      const tls = buildTls(node, { force: node.protocol === 'https' });
      if (tls) outbound.tls = tls;
      return outbound;
    }
  })
});
