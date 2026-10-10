'use strict';

const { encodeTrojanLink, parseTrojanLink } = require('../protocol-parsers/trojan-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS, TRANSPORT_FIELDS } = require('../protocol-fields');

module.exports = Object.freeze({
  id: 'trojan',
  capability: 'proxy-pool.protocol',
  name: 'Trojan',
  protocols: Object.freeze(['trojan']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['trojan']),
  fields: Object.freeze({ password: 'string', ...TRANSPORT_FIELDS, ...TLS_FIELDS }),
  required: Object.freeze(['password']),
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
    }
  })
});
