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
const { loonTlsFields, loonTransportFields, quantumultXObfsFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { quantumultXObfsParams, tlsVerification } = require('../cores/surge/quantumult-x-fields');
const { egernTransport, requiredValue } = require('../cores/egern/proxy-fields');
const { egernTransportFields } = require('../protocol-parsers/egern-fields');

// VLESS Encryption：`none` 与空值等于没开；其余（mlkem768x25519plus…）只有 mihomo / Stash 与分享链接能表达。
function normalizedEncryption(value) {
  const text = String(value ?? '').trim();
  return text && text.toLowerCase() !== 'none' ? text : undefined;
}

function vlessEncryption(node) {
  return normalizedEncryption(node.encryption);
}

function unsupportedEncryption() {
  return protocolFieldError('unsupported_vless_encryption');
}

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
    // XHTTP 的 mode（auto / packet-up / stream-up …），只有 xhttp 传输用得上。
    mode: 'string',
    // VLESS Encryption（ML-KEM）与它的后量子校验参数。
    encryption: 'string',
    pqv: 'string',
    ...TRANSPORT_FIELDS,
    ...TLS_FIELDS
  }),
  required: Object.freeze(['uuid']),
  // pqv 只是加密的后量子校验开关，由客户端决定，不计入连接身份。
  clientTuning: Object.freeze(['pqv']),
  validate(node) {
    const security = String(node.security || '').trim().toLowerCase();
    if (security && !['none', 'tls', 'reality'].includes(security)) {
      throw protocolFieldError(`unsupported_proxy_security_${security}`);
    }
    if (security === 'reality' && !node.publicKey) {
      throw protocolFieldError('missing_required_proxy_field_publicKey');
    }
  },
  form: Object.freeze({
    options: Object.freeze({
      flow: Object.freeze(['xtls-rprx-vision']),
      security: Object.freeze(['none', 'tls', 'reality'])
    })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['vless']),
      parse(proxy) {
        const reality = asObject(proxy['reality-opts']);
        return {
          uuid: optionalString(proxy.uuid),
          flow: optionalString(proxy.flow),
          encryption: normalizedEncryption(proxy.encryption),
          ...clashTls(proxy),
          // xhttp 只有 VLESS 能用，这里显式打开。
          ...clashTransport(proxy, { xhttp: true }),
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
    }),
    'quantumult-x': Object.freeze({
      types: Object.freeze(['vless']),
      parse({ params }) {
        const publicKey = optionalString(params['reality-base64-pubkey']);
        return {
          uuid: optionalString(params.password),
          flow: optionalString(params['vless-flow']),
          ...quantumultXObfsFields(params),
          ...(publicKey ? {
            tls: true,
            security: 'reality',
            publicKey,
            shortId: optionalString(params['reality-hex-shortid'])
          } : {})
        };
      }
    }),
    egern: Object.freeze({
      types: Object.freeze(['vless']),
      parse: (proxy) => ({
        uuid: optionalString(proxy.user_id),
        flow: optionalString(proxy.flow),
        ...egernTransportFields(proxy.transport)
      })
    }),
    xray: Object.freeze({
      types: Object.freeze(['vless']),
      parse({ user, stream }) {
        return {
          uuid: optionalString(user.id),
          flow: optionalString(user.flow),
          encryption: normalizedEncryption(user.encryption),
          ...stream
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
      // VLESS Encryption：mihomo 与 Stash 认这个键。
      const encryption = vlessEncryption(node);
      if (encryption) proxy.encryption = encryption;
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
      // sing-box 没有 VLESS Encryption，也没有 xhttp 传输：跳过而不是编出一份连不上的配置。
      if (vlessEncryption(node)) throw unsupportedEncryption();
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
      if (vlessEncryption(node)) throw unsupportedEncryption();
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
    },
    'quantumult-x'(node) {
      if (vlessEncryption(node)) throw unsupportedEncryption();
      const reality = String(node.security || '').toLowerCase() === 'reality';
      return {
        type: 'vless',
        params: {
          method: 'none',
          password: requiredText(node, 'uuid'),
          ...quantumultXObfsParams(node),
          'reality-base64-pubkey': reality ? requiredText(node, 'publicKey') : undefined,
          'reality-hex-shortid': reality ? node.shortId || undefined : undefined,
          'vless-flow': node.flow || undefined,
          'tls-verification': tlsVerification(node),
          'udp-relay': false
        }
      };
    },
    egern(node) {
      if (vlessEncryption(node)) throw unsupportedEncryption();
      return {
        type: 'vless',
        fields: {
          user_id: requiredValue(node, 'uuid'),
          flow: node.flow || undefined,
          udp_relay: true,
          transport: egernTransport(node)
        }
      };
    }
  })
});
