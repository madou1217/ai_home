'use strict';

const { encodeStandardProxyLink, parseStandardProxyLink } = require('../protocol-parsers/standard-parser');
const { optionalString } = require('../protocol-parsers/clash-fields');
const { protocolFieldError } = require('../protocol-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { plainTcpStream } = require('../protocol-parsers/xray-fields');

module.exports = Object.freeze({
  id: 'socks5',
  capability: 'proxy-pool.protocol',
  name: 'SOCKS5',
  protocols: Object.freeze(['socks5']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['socks5', 'socks']),
  fields: Object.freeze({ username: 'string', password: 'string' }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['socks5', 'socks']),
      parse: (proxy) => ({
        username: optionalString(proxy.username),
        password: optionalString(proxy.password)
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['socks']),
      parse(outbound) {
        const version = String(outbound.version || '5');
        if (version !== '5') throw protocolFieldError(`unsupported_proxy_protocol_socks${version}`);
        return { username: optionalString(outbound.username), password: optionalString(outbound.password) };
      }
    }),
    surge: Object.freeze({
      types: Object.freeze(['socks5']),
      parse: ({ args }) => ({ username: optionalString(args[2]), password: optionalString(args[3]) })
    }),
    'quantumult-x': Object.freeze({
      types: Object.freeze(['socks5']),
      parse({ params }) {
        if (/^true$/i.test(String(params['over-tls'] || ''))) throw protocolFieldError('unsupported_proxy_protocol_socks5-tls');
        return { username: optionalString(params.username), password: optionalString(params.password) };
      }
    }),
    // socks5_tls 是另一个 Egern 类型，不归这里（导入时列为不支持的协议）。
    egern: Object.freeze({
      types: Object.freeze(['socks5']),
      parse: (proxy) => ({ username: optionalString(proxy.username), password: optionalString(proxy.password) })
    }),
    xray: Object.freeze({
      types: Object.freeze(['socks']),
      parse({ user, stream }) {
        plainTcpStream(stream);
        return { username: optionalString(user.user), password: optionalString(user.pass) };
      }
    })
  }),
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
    },
    surge: (node) => ({
      type: 'socks5',
      args: node.username ? [node.username, node.password || ''] : []
    }),
    loon: (node) => ({
      type: 'socks5',
      args: node.username ? [node.username, quoted(node.password || '')] : []
    }),
    'quantumult-x': (node) => ({
      type: 'socks5',
      params: { username: node.username, password: node.password, 'fast-open': false, 'udp-relay': false }
    }),
    egern: (node) => ({
      type: 'socks5',
      fields: { username: node.username || undefined, password: node.password || undefined, udp_relay: true }
    })
  })
});
