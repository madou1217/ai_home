'use strict';

const { encodeTrojanLink, parseTrojanLink } = require('../protocol-parsers/trojan-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS, TRANSPORT_FIELDS, protocolFieldError } = require('../protocol-fields');
const { asObject, clashTls, clashTransport, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls, singBoxTransport } = require('../protocol-parsers/sing-box-fields');
const { loonTlsParams, loonTransportParams, requiredText, surgeTlsParams, surgeTransportParams } = require('../cores/surge/proxy-fields');
const { loonTlsFields, loonTransportFields, quantumultXObfsFields, surgeTlsFields, surgeTransportFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { quantumultXObfsParams, tlsVerification } = require('../cores/surge/quantumult-x-fields');
const { egernReality, egernTls, requiredValue } = require('../cores/egern/proxy-fields');
const { egernRealityFields, egernTlsFields } = require('../protocol-parsers/egern-fields');

module.exports = Object.freeze({
  id: 'trojan',
  capability: 'proxy-pool.protocol',
  name: 'Trojan',
  protocols: Object.freeze(['trojan']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['trojan']),
  fields: Object.freeze({ password: 'string', ...TRANSPORT_FIELDS, ...TLS_FIELDS }),
  required: Object.freeze(['password']),
  form: Object.freeze({ defaults: Object.freeze({ tls: true }) }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['trojan']),
      parse: (proxy) => ({
        password: optionalString(proxy.password),
        ...clashTls(proxy, { forceTls: true }),
        ...clashTransport(proxy)
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['trojan']),
      parse: (outbound) => ({
        password: optionalString(outbound.password),
        ...singBoxTls(outbound, { forceTls: true }),
        ...singBoxTransport(outbound)
      })
    }),
    surge: Object.freeze({
      types: Object.freeze(['trojan']),
      parse: ({ params }) => ({
        password: optionalString(params.password),
        ...surgeTlsFields(params, { forceTls: true }),
        ...surgeTransportFields(params)
      })
    }),
    loon: Object.freeze({
      types: Object.freeze(['trojan']),
      parse: ({ args, params }) => ({
        password: optionalString(args[2]),
        ...loonTlsFields(params, { forceTls: true }),
        ...loonTransportFields(params)
      })
    }),
    'quantumult-x': Object.freeze({
      types: Object.freeze(['trojan']),
      parse({ params }) {
        const obfs = quantumultXObfsFields(params);
        return {
          password: optionalString(params.password),
          ...obfs,
          tls: true,
          sni: obfs.sni || optionalString(params['tls-host']),
          allowInsecure: String(params['tls-verification'] ?? '').trim().toLowerCase() === 'false' || undefined
        };
      }
    }),
    // Egern 的 Trojan 只有 tcp 与 websocket 两种传输，TLS 字段写在条目本身。
    egern: Object.freeze({
      types: Object.freeze(['trojan']),
      parse(proxy) {
        const websocket = proxy.websocket ? asObject(proxy.websocket) : null;
        return {
          password: optionalString(proxy.password),
          tls: true,
          ...egernTlsFields(proxy),
          ...egernRealityFields(proxy.reality),
          ...(websocket
            ? { network: 'ws', path: optionalString(websocket.path), host: optionalString(websocket.host) }
            : { network: 'tcp' })
        };
      }
    }),
    // Trojan 节点总是走 TLS（各输出格式都强制开启），与其它格式的导入一致。
    xray: Object.freeze({
      types: Object.freeze(['trojan']),
      parse: ({ user, stream }) => ({ password: optionalString(user.password), ...stream, tls: true })
    })
  }),
  parse: parseTrojanLink,
  encode: encodeTrojanLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'trojan';
      proxy.password = requiredString(node, 'password');
      transportOptions(node, proxy);
      tlsOptions({ ...node, tls: true }, proxy);
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password')
      };
      const transport = buildTransport(node);
      const tls = buildTls(node, { force: true });
      if (transport) outbound.transport = transport;
      if (tls) outbound.tls = tls;
      return outbound;
    },
    surge: (node) => ({
      type: 'trojan',
      params: {
        password: requiredText(node, 'password'),
        ...surgeTransportParams(node),
        ...surgeTlsParams(node)
      }
    }),
    loon: (node) => ({
      type: 'trojan',
      args: [quoted(requiredText(node, 'password'))],
      params: {
        ...loonTransportParams(node),
        ...loonTlsParams(node, { forceTls: true })
      }
    }),
    'quantumult-x'(node) {
      const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
      // trojan 天然走 TLS：tcp 用 over-tls + tls-host，ws 用 obfs=wss。
      const transport = network === 'tcp'
        ? { 'over-tls': true, 'tls-host': node.sni || undefined }
        : quantumultXObfsParams(node, { forceTls: true });
      return {
        type: 'trojan',
        params: {
          password: requiredText(node, 'password'),
          ...transport,
          'tls-verification': tlsVerification(node),
          'fast-open': false,
          'udp-relay': false
        }
      };
    },
    // Egern 的 Trojan 只有 tcp 与 websocket 两种传输。
    egern(node) {
      const network = String(node.network || 'tcp').trim().toLowerCase() || 'tcp';
      if (network !== 'tcp' && network !== 'ws') throw protocolFieldError(`unsupported_proxy_transport_${network}`);
      return {
        type: 'trojan',
        fields: {
          password: requiredValue(node, 'password'),
          ...egernTls(node),
          reality: egernReality(node),
          websocket: network === 'ws' ? { path: node.path || '/', host: node.host || undefined } : undefined,
          udp_relay: true
        }
      };
    }
  })
});
