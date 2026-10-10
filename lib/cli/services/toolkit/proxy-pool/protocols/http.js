'use strict';

const { encodeStandardProxyLink, parseStandardProxyLink } = require('../protocol-parsers/standard-parser');
const { buildTls } = require('../cores/sing-box/outbound-fields');
const { enabled, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { surgeTlsParams } = require('../cores/surge/proxy-fields');
const { surgeTlsFields } = require('../protocol-parsers/surge-fields');

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
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['http', 'https']),
      parse(proxy) {
        const https = String(proxy.type || '').toLowerCase() === 'https';
        return {
          protocol: https ? 'https' : 'http',
          username: optionalString(proxy.username),
          password: optionalString(proxy.password),
          tls: https || enabled(proxy.tls) || undefined,
          sni: optionalString(proxy.sni),
          allowInsecure: enabled(proxy['skip-cert-verify']) || undefined
        };
      }
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['http']),
      parse(outbound) {
        const tls = singBoxTls(outbound);
        return {
          protocol: tls.tls ? 'https' : 'http',
          username: optionalString(outbound.username),
          password: optionalString(outbound.password),
          tls: tls.tls,
          sni: tls.sni,
          allowInsecure: tls.allowInsecure
        };
      }
    }),
    surge: Object.freeze({
      types: Object.freeze(['http', 'https']),
      parse: ({ type, args, params }) => ({
        protocol: type,
        username: optionalString(args[2]),
        password: optionalString(args[3]),
        ...(type === 'https' ? surgeTlsFields(params, { forceTls: true }) : {})
      })
    })
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
    },
    surge(node) {
      const https = node.protocol === 'https' || node.tls === true;
      return {
        type: https ? 'https' : 'http',
        args: node.username ? [node.username, node.password || ''] : [],
        params: https ? surgeTlsParams(node) : {}
      };
    }
  })
});
