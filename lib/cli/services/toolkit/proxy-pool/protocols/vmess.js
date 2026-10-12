'use strict';

const { encodeVMessLink, parseVMessLink } = require('../protocol-parsers/vmess-parser');
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
const { flag, loonTlsFields, loonTransportFields, quantumultXObfsFields, surgeTlsFields, surgeTransportFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { quantumultXObfsParams, tlsVerification } = require('../cores/surge/quantumult-x-fields');
const { egernTransport, requiredValue } = require('../cores/egern/proxy-fields');
const { egernTransportFields } = require('../protocol-parsers/egern-fields');

// Egern 的 VMess 只认这几种加密；加密方式是客户端调优项，其余一律用 auto。
const EGERN_SECURITY = new Set(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']);

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
  // VMess 的加密方式由客户端自选、服务端都接受，不计入连接身份（QX 不认 auto，会换成具体算法）。
  clientTuning: Object.freeze(['cipher']),
  form: Object.freeze({
    options: Object.freeze({ cipher: Object.freeze(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']) }),
    defaults: Object.freeze({ cipher: 'auto', alterId: 0 })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['vmess']),
      parse: (proxy) => ({
        uuid: optionalString(proxy.uuid),
        alterId: Number(proxy.alterId ?? proxy['alter-id'] ?? 0) || 0,
        cipher: optionalString(proxy.cipher),
        ...clashTls(proxy),
        ...clashTransport(proxy)
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['vmess']),
      parse: (outbound) => ({
        uuid: optionalString(outbound.uuid),
        alterId: Number(outbound.alter_id ?? 0) || 0,
        cipher: optionalString(outbound.security),
        ...singBoxTls(outbound),
        ...singBoxTransport(outbound)
      })
    }),
    surge: Object.freeze({
      types: Object.freeze(['vmess']),
      // Surge 默认是旧版 MD5 认证；只有 vmess-aead=true 对应 alterId 0。
      parse: ({ params }) => ({
        uuid: optionalString(params.username),
        alterId: flag(params['vmess-aead']) ? 0 : 1,
        cipher: 'auto',
        ...surgeTlsFields(params),
        ...surgeTransportFields(params)
      })
    }),
    loon: Object.freeze({
      types: Object.freeze(['vmess']),
      parse: ({ args, params }) => ({
        cipher: optionalString(args[2]) || 'auto',
        uuid: optionalString(args[3]),
        alterId: Number(params.alterid ?? 0) || 0,
        ...loonTlsFields(params),
        ...loonTransportFields(params)
      })
    }),
    'quantumult-x': Object.freeze({
      types: Object.freeze(['vmess']),
      parse: ({ params }) => ({
        uuid: optionalString(params.password),
        cipher: optionalString(params.method) || 'auto',
        alterId: 0,
        ...quantumultXObfsFields(params)
      })
    }),
    // Egern 只区分 AEAD 与旧版认证（legacy），具体 alterId 不保留：旧版按 1 处理（同 Surge）。
    egern: Object.freeze({
      types: Object.freeze(['vmess']),
      parse: (proxy) => ({
        uuid: optionalString(proxy.user_id),
        cipher: optionalString(proxy.security),
        alterId: proxy.legacy === true ? 1 : 0,
        ...egernTransportFields(proxy.transport)
      })
    }),
    xray: Object.freeze({
      types: Object.freeze(['vmess']),
      parse: ({ user, stream }) => ({
        uuid: optionalString(user.id),
        alterId: Number(user.alterId ?? 0) || 0,
        cipher: optionalString(user.security),
        ...stream
      })
    })
  }),
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
    },
    surge: (node) => ({
      type: 'vmess',
      params: {
        username: requiredText(node, 'uuid'),
        ...surgeTransportParams(node),
        tls: node.tls === true ? true : undefined,
        ...surgeTlsParams(node),
        'vmess-aead': Number(node.alterId || 0) === 0 ? true : undefined
      }
    }),
    loon: (node) => ({
      type: 'vmess',
      args: [String(node.cipher || 'auto'), quoted(requiredText(node, 'uuid'))],
      params: {
        ...loonTransportParams(node),
        alterId: Number(node.alterId || 0),
        ...loonTlsParams(node)
      }
    }),
    'quantumult-x'(node) {
      const cipher = String(node.cipher || 'auto').trim().toLowerCase() || 'auto';
      return {
        type: 'vmess',
        params: {
          method: cipher === 'auto' ? 'chacha20-poly1305' : cipher,
          password: requiredText(node, 'uuid'),
          ...quantumultXObfsParams(node),
          'tls-verification': tlsVerification(node),
          'fast-open': false,
          'udp-relay': false
        }
      };
    },
    egern(node) {
      const cipher = String(node.cipher || 'auto').trim().toLowerCase();
      return {
        type: 'vmess',
        fields: {
          user_id: requiredValue(node, 'uuid'),
          security: EGERN_SECURITY.has(cipher) ? cipher : 'auto',
          // alterId > 0 是旧版（非 AEAD）认证。
          legacy: Number(node.alterId || 0) > 0 || undefined,
          udp_relay: true,
          transport: egernTransport(node)
        }
      };
    }
  })
});
