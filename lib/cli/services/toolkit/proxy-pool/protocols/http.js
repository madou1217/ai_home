'use strict';

const { encodeStandardProxyLink, parseStandardProxyLink } = require('../protocol-parsers/standard-parser');
const { buildTls } = require('../cores/sing-box/outbound-fields');
const { enabled, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { surgeTlsParams } = require('../cores/surge/proxy-fields');
const { flag, surgeTlsFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { tlsVerification } = require('../cores/surge/quantumult-x-fields');
const { egernTls } = require('../cores/egern/proxy-fields');
const { egernRealityFields, egernTlsFields } = require('../protocol-parsers/egern-fields');
const { plainTcpStream } = require('../protocol-parsers/xray-fields');

module.exports = Object.freeze({
  id: 'http',
  capability: 'proxy-pool.protocol',
  name: 'HTTP / HTTPS',
  protocols: Object.freeze(['http', 'https']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['http', 'https']),
  udpRelay: false,
  fields: Object.freeze({
    username: 'string',
    password: 'string',
    tls: 'boolean',
    sni: 'string',
    allowInsecure: 'boolean'
  }),
  // 同一个插件管 http 与 https：https 的表单默认打开 TLS。
  form: Object.freeze({ protocolDefaults: Object.freeze({ https: Object.freeze({ tls: true }) }) }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['http', 'https']),
      parse(proxy) {
        // Clash 里 HTTPS 代理写作 type: http + tls: true。
        const https = String(proxy.type || '').toLowerCase() === 'https' || enabled(proxy.tls);
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
    }),
    'quantumult-x': Object.freeze({
      types: Object.freeze(['http']),
      parse({ params }) {
        const https = flag(params['over-tls']);
        return {
          protocol: https ? 'https' : 'http',
          username: optionalString(params.username),
          password: optionalString(params.password),
          ...(https ? {
            tls: true,
            sni: optionalString(params['tls-host']),
            allowInsecure: String(params['tls-verification'] ?? '').trim().toLowerCase() === 'false' || undefined
          } : {})
        };
      }
    }),
    // Egern 用条目类型区分 http 与 https（类型由解析器作为第二个参数传入）；https 的 REALITY 如实带出，
    // 由节点库按字段声明拒绝。
    egern: Object.freeze({
      types: Object.freeze(['http', 'https']),
      parse(proxy, type) {
        const https = type === 'https';
        return {
          protocol: https ? 'https' : 'http',
          username: optionalString(proxy.username),
          password: optionalString(proxy.password),
          ...(https ? { tls: true, ...egernTlsFields(proxy), ...egernRealityFields(proxy.reality) } : {})
        };
      }
    }),
    // Xray 的 http 出站套 TLS 即 HTTPS 代理。
    xray: Object.freeze({
      types: Object.freeze(['http']),
      parse({ user, stream }) {
        const { tls, sni, allowInsecure } = plainTcpStream(stream, { allowTls: true });
        return {
          protocol: tls ? 'https' : 'http',
          username: optionalString(user.user),
          password: optionalString(user.pass),
          tls,
          sni,
          allowInsecure
        };
      }
    })
  }),
  parse: parseStandardProxyLink,
  encode: encodeStandardProxyLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'http';
      if (node.username) proxy.username = String(node.username);
      if (node.password) proxy.password = String(node.password);
      if (node.protocol === 'https' || node.tls === true) {
        proxy.tls = true;
        if (node.sni) proxy.sni = String(node.sni);
        if (node.allowInsecure === true) proxy['skip-cert-verify'] = true;
      }
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
    },
    loon(node) {
      const https = node.protocol === 'https' || node.tls === true;
      return {
        type: https ? 'https' : 'http',
        args: node.username ? [node.username, quoted(node.password || '')] : [],
        params: https ? surgeTlsParams(node) : {}
      };
    },
    'quantumult-x'(node) {
      const https = node.protocol === 'https' || node.tls === true;
      return {
        type: 'http',
        params: {
          username: node.username,
          password: node.password,
          'over-tls': https ? true : undefined,
          'tls-host': https ? node.sni || undefined : undefined,
          'tls-verification': https ? tlsVerification(node) : undefined,
          'fast-open': false,
          'udp-relay': false
        }
      };
    },
    egern(node) {
      const https = node.protocol === 'https' || node.tls === true;
      return {
        type: https ? 'https' : 'http',
        fields: { username: node.username || undefined, password: node.password || undefined, ...(https ? egernTls(node) : {}) }
      };
    }
  })
});
