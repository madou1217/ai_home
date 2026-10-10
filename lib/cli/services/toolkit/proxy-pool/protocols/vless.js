'use strict';

const { encodeVLESSLink, parseVLESSLink } = require('../protocol-parsers/vless-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');

module.exports = Object.freeze({
  id: 'vless',
  capability: 'proxy-pool.protocol',
  name: 'VLESS',
  protocols: Object.freeze(['vless']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['vless']),
  parse: parseVLESSLink,
  encode: encodeVLESSLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'vless';
      proxy.uuid = requiredString(node, 'uuid');
      transportOptions(node, proxy);
      tlsOptions(node, proxy);
      if (node.flow) proxy.flow = String(node.flow);
      const security = String(node.security || (node.tls ? 'tls' : 'none')).toLowerCase();
      if (!['none', 'tls', 'reality'].includes(security)) {
        throw new Error(`unsupported_proxy_security_${security}`);
      }
      if (security === 'tls') proxy.tls = true;
      if (security === 'reality' || node.publicKey) {
        if (!node.publicKey) throw new Error('missing_required_proxy_field_publicKey');
        proxy.tls = true;
        proxy['reality-opts'] = {
          'public-key': String(node.publicKey),
          'short-id': String(node.shortId || '')
        };
        proxy['client-fingerprint'] = String(node.fingerprint || 'chrome');
      } else if (node.fingerprint) {
        proxy['client-fingerprint'] = String(node.fingerprint);
      }
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        uuid: requireSingBoxString(node.uuid, 'missing_required_proxy_field_uuid')
      };
      const flow = String(node.flow || '').trim();
      const transport = buildTransport(node);
      const tls = buildTls(node);
      if (flow) outbound.flow = flow;
      if (transport) outbound.transport = transport;
      if (tls) outbound.tls = tls;
      return outbound;
    }
  })
});
