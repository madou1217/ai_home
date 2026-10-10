'use strict';

const { encodeVMessLink, parseVMessLink } = require('../protocol-parsers/vmess-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS, TRANSPORT_FIELDS } = require('../protocol-fields');

module.exports = Object.freeze({
  id: 'vmess',
  capability: 'proxy-pool.protocol',
  name: 'VMess',
  protocols: Object.freeze(['vmess']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['vmess']),
  fields: Object.freeze({
    uuid: 'string',
    cipher: 'string',
    alterId: 'count',
    type: 'string',
    ...TRANSPORT_FIELDS,
    ...TLS_FIELDS
  }),
  required: Object.freeze(['uuid']),
  parse: parseVMessLink,
  encode: encodeVMessLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      if (node.type && node.type !== 'none') throw new Error(`unsupported_proxy_field_type_${node.type}`);
      proxy.type = 'vmess';
      proxy.uuid = requiredString(node, 'uuid');
      proxy.alterId = Number.isInteger(Number(node.alterId)) ? Number(node.alterId) : 0;
      proxy.cipher = node.cipher || 'auto';
      transportOptions(node, proxy);
      tlsOptions(node, proxy);
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        uuid: requireSingBoxString(node.uuid, 'missing_required_proxy_field_uuid'),
        security: String(node.cipher || 'auto').trim() || 'auto',
        alter_id: Number.isInteger(Number(node.alterId)) ? Number(node.alterId) : 0
      };
      const transport = buildTransport(node);
      const tls = buildTls(node);
      if (transport) outbound.transport = transport;
      if (tls) outbound.tls = tls;
      return outbound;
    }
  })
});
