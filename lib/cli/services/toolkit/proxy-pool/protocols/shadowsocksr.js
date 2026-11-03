'use strict';

const { encodeSSRLink, parseSSRLink } = require('../protocol-parsers/ssr-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { requiredText } = require('../cores/surge/proxy-fields');
const { optionalString } = require('../protocol-parsers/clash-fields');
const { quoted } = require('../protocol-parsers/surge-line');

// 协议与混淆缺省时按 SSR 客户端的约定取 origin / plain（即不加协议插件、不混淆）。
const protocolOf = (node) => String(node.ssrProtocol || 'origin');
const obfsOf = (node) => String(node.ssrObfs || 'plain');

module.exports = Object.freeze({
  id: 'shadowsocksr',
  capability: 'proxy-pool.protocol',
  name: 'ShadowsocksR',
  protocols: Object.freeze(['shadowsocksr']),
  aliases: Object.freeze(['ssr']),
  uriSchemes: Object.freeze(['ssr']),
  fields: Object.freeze({
    cipher: 'string',
    password: 'string',
    ssrProtocol: 'string',
    ssrProtocolParam: 'string',
    ssrObfs: 'string',
    ssrObfsParam: 'string'
  }),
  required: Object.freeze(['cipher', 'password']),
  form: Object.freeze({
    options: Object.freeze({
      cipher: Object.freeze(['aes-128-cfb', 'aes-256-cfb', 'chacha20-ietf', 'rc4-md5', 'none']),
      ssrProtocol: Object.freeze(['origin', 'auth_sha1_v4', 'auth_aes128_md5', 'auth_aes128_sha1', 'auth_chain_a', 'auth_chain_b']),
      ssrObfs: Object.freeze(['plain', 'http_simple', 'http_post', 'random_head', 'tls1.2_ticket_auth', 'tls1.2_ticket_fastauth'])
    })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['ssr', 'shadowsocksr']),
      parse: (proxy) => ({
        cipher: optionalString(proxy.cipher),
        password: optionalString(proxy.password),
        ssrProtocol: optionalString(proxy.protocol),
        ssrProtocolParam: optionalString(proxy['protocol-param']),
        ssrObfs: optionalString(proxy.obfs),
        ssrObfsParam: optionalString(proxy['obfs-param'])
      })
    }),
    loon: Object.freeze({
      types: Object.freeze(['shadowsocksr']),
      parse: ({ args, params }) => ({
        cipher: optionalString(args[2]),
        password: optionalString(args[3]),
        ssrProtocol: optionalString(params.protocol),
        ssrProtocolParam: optionalString(params['protocol-param']),
        ssrObfs: optionalString(params.obfs),
        ssrObfsParam: optionalString(params['obfs-param'])
      })
    }),
    // QX 把 SSR 写成带 ssr-protocol 的 shadowsocks 行（解析器据此改认 shadowsocksr）。
    'quantumult-x': Object.freeze({
      types: Object.freeze(['shadowsocksr']),
      parse: ({ params }) => ({
        cipher: optionalString(params.method),
        password: optionalString(params.password),
        ssrProtocol: optionalString(params['ssr-protocol']),
        ssrProtocolParam: optionalString(params['ssr-protocol-param']),
        ssrObfs: optionalString(params.obfs),
        ssrObfsParam: optionalString(params['obfs-host'])
      })
    })
  }),
  parse: parseSSRLink,
  encode: encodeSSRLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'ssr';
      proxy.cipher = requiredString(node, 'cipher');
      proxy.password = requiredString(node, 'password');
      proxy.protocol = protocolOf(node);
      if (node.ssrProtocolParam) proxy['protocol-param'] = String(node.ssrProtocolParam);
      proxy.obfs = obfsOf(node);
      if (node.ssrObfsParam) proxy['obfs-param'] = String(node.ssrObfsParam);
      return proxy;
    },
    loon: (node) => ({
      type: 'ShadowsocksR',
      args: [requiredText(node, 'cipher'), quoted(requiredText(node, 'password'))],
      params: {
        protocol: protocolOf(node),
        'protocol-param': node.ssrProtocolParam,
        obfs: obfsOf(node),
        'obfs-param': node.ssrObfsParam,
        'fast-open': false,
        udp: true
      }
    }),
    'quantumult-x': (node) => ({
      type: 'shadowsocks',
      params: {
        method: requiredText(node, 'cipher'),
        password: requiredText(node, 'password'),
        'ssr-protocol': protocolOf(node),
        'ssr-protocol-param': node.ssrProtocolParam,
        obfs: obfsOf(node),
        'obfs-host': node.ssrObfsParam,
        'fast-open': false,
        'udp-relay': false
      }
    })
  })
});
