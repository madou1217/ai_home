'use strict';

const { encodeVLESSLink, parseVLESSLink } = require('../protocol-parsers/vless-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS, TRANSPORT_FIELDS, protocolFieldError } = require('../protocol-fields');
const { asObject, clashTls, clashTransport, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls, singBoxTransport } = require('../protocol-parsers/sing-box-fields');
const { loonTlsParams, loonTransportParams, requiredText } = require('../cores/surge/proxy-fields');
const { loonTlsFields, loonTransportFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');

module.exports = Object.freeze({
  id: 'vless',
  capability: 'proxy-pool.protocol',
  name: 'VLESS',
  protocols: Object.freeze(['vless']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['vless']),
  fields: Object.freeze({
    uuid: 'string',
    flow: 'string',
    security: 'string',
    publicKey: 'string',
    shortId: 'string',
    ...TRANSPORT_FIELDS,
    ...TLS_FIELDS
  }),
  required: Object.freeze(['uuid']),
  validate(node) {
    const security = String(node.security || '').trim().toLowerCase();
    if (security && !['none', 'tls', 'reality'].includes(security)) {
      throw protocolFieldError(`unsupported_proxy_security_${security}`);
    }
    if (security === 'reality' && !node.publicKey) {
      throw protocolFieldError('missing_required_proxy_field_publicKey');
    }
  },
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['vless']),
      parse(proxy) {
        const reality = asObject(proxy['reality-opts']);
        return {
          uuid: optionalString(proxy.uuid),
          flow: optionalString(proxy.flow),
          ...clashTls(proxy),
          ...clashTransport(proxy),
          ...(Object.keys(reality).length > 0 ? {
            tls: true,
            security: 'reality',
            publicKey: optionalString(reality['public-key']),
            shortId: optionalString(reality['short-id'])
          } : {})
        };
      }
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['vless']),
      parse: (outbound) => ({
        uuid: optionalString(outbound.uuid),
        flow: optionalString(outbound.flow),
        ...singBoxTls(outbound),
        ...singBoxTransport(outbound)
      })
    }),
    loon: Object.freeze({
      types: Object.freeze(['vless']),
      parse({ args, params }) {
        const publicKey = optionalString(params['public-key']);
        return {
          uuid: optionalString(args[2]),
          flow: optionalString(params.flow),
          ...loonTlsFields(params),
          ...loonTransportFields(params),
          ...(publicKey ? { tls: true, security: 'reality', publicKey, shortId: optionalString(params['short-id']) } : {})
        };
      }
    })
  }),
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
    },
    loon(node) {
      const reality = String(node.security || '').toLowerCase() === 'reality';
      return {
        type: 'VLESS',
        args: [quoted(requiredText(node, 'uuid'))],
        params: {
          ...loonTransportParams(node),
          flow: node.flow || undefined,
          'public-key': reality ? quoted(requiredText(node, 'publicKey')) : undefined,
          'short-id': reality ? node.shortId || undefined : undefined,
          ...loonTlsParams({ ...node, tls: node.tls === true || reality })
        }
      };
    }
  })
});
