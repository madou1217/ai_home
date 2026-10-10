'use strict';

const { encodeTrojanLink, parseTrojanLink } = require('../protocol-parsers/trojan-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS, TRANSPORT_FIELDS } = require('../protocol-fields');
const { clashTls, clashTransport, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls, singBoxTransport } = require('../protocol-parsers/sing-box-fields');
const { loonTlsParams, loonTransportParams, requiredText, surgeTlsParams, surgeTransportParams } = require('../cores/surge/proxy-fields');
const { loonTlsFields, loonTransportFields, surgeTlsFields, surgeTransportFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');

module.exports = Object.freeze({
  id: 'trojan',
  capability: 'proxy-pool.protocol',
  name: 'Trojan',
  protocols: Object.freeze(['trojan']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['trojan']),
  fields: Object.freeze({ password: 'string', ...TRANSPORT_FIELDS, ...TLS_FIELDS }),
  required: Object.freeze(['password']),
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
    })
  })
});
