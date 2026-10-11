'use strict';

const { encodeTuicLink, parseTuicLink } = require('../protocol-parsers/tuic-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { buildTls, normalizeAlpn, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { requiredText, surgeTlsParams } = require('../cores/surge/proxy-fields');
const { TLS_FIELDS, protocolFieldError } = require('../protocol-fields');
const { clashTls, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { surgeTlsFields } = require('../protocol-parsers/surge-fields');
const { egernTls, requiredValue } = require('../cores/egern/proxy-fields');

module.exports = Object.freeze({
  id: 'tuic',
  capability: 'proxy-pool.protocol',
  name: 'TUIC v5',
  protocols: Object.freeze(['tuic']),
  aliases: Object.freeze(['tuic-v5']),
  uriSchemes: Object.freeze(['tuic']),
  fields: Object.freeze({
    uuid: 'string',
    password: 'string',
    congestionControl: 'string',
    udpRelayMode: 'string',
    ...TLS_FIELDS
  }),
  required: Object.freeze(['uuid', 'password']),
  // 拥塞控制与 UDP 中继方式由客户端各自选择（服务端都接受），不计入连接指纹；Surge 也不提供这两项。
  clientTuning: Object.freeze(['congestionControl', 'udpRelayMode']),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['tuic']),
      parse(proxy) {
        if (!proxy.uuid && proxy.token) throw protocolFieldError('unsupported_proxy_protocol_tuic-v4');
        return {
          uuid: optionalString(proxy.uuid),
          password: optionalString(proxy.password),
          congestionControl: optionalString(proxy['congestion-controller']),
          udpRelayMode: optionalString(proxy['udp-relay-mode']),
          ...clashTls(proxy, { forceTls: true })
        };
      }
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['tuic']),
      parse: (outbound) => ({
        uuid: optionalString(outbound.uuid),
        password: optionalString(outbound.password),
        congestionControl: optionalString(outbound.congestion_control),
        udpRelayMode: optionalString(outbound.udp_relay_mode),
        ...singBoxTls(outbound, { forceTls: true })
      })
    }),
    surge: Object.freeze({
      types: Object.freeze(['tuic-v5']),
      parse: ({ params }) => ({
        uuid: optionalString(params.uuid),
        password: optionalString(params.password),
        alpn: optionalString(params.alpn),
        ...surgeTlsFields(params, { forceTls: true })
      })
    })
  }),
  parse: parseTuicLink,
  encode: encodeTuicLink,
  // mihomo 与 sing-box 缺省 ALPN 即 h3；Surge 的示例总带 alpn，输出时补上。
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'tuic';
      proxy.uuid = requiredString(node, 'uuid');
      proxy.password = requiredString(node, 'password');
      const alpn = normalizeAlpn(node.alpn);
      if (alpn) proxy.alpn = alpn;
      if (node.congestionControl) proxy['congestion-controller'] = String(node.congestionControl);
      if (node.udpRelayMode) proxy['udp-relay-mode'] = String(node.udpRelayMode);
      if (node.sni) proxy.sni = String(node.sni);
      if (node.allowInsecure || node.insecure) proxy['skip-cert-verify'] = true;
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        uuid: requireSingBoxString(node.uuid, 'missing_required_proxy_field_uuid'),
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password'),
        tls: buildTls(node, { force: true })
      };
      if (node.congestionControl) outbound.congestion_control = String(node.congestionControl);
      if (node.udpRelayMode) outbound.udp_relay_mode = String(node.udpRelayMode);
      return outbound;
    },
    surge: (node) => ({
      type: 'tuic-v5',
      params: {
        uuid: requiredText(node, 'uuid'),
        password: requiredText(node, 'password'),
        alpn: (normalizeAlpn(node.alpn) || ['h3']).join(','),
        ...surgeTlsParams(node)
      }
    }),
    egern: (node) => ({
      type: 'tuic',
      fields: {
        uuid: requiredValue(node, 'uuid'),
        password: requiredValue(node, 'password'),
        udp_relay_mode: node.udpRelayMode || undefined,
        alpn: normalizeAlpn(node.alpn) || ['h3'],
        ...egernTls(node)
      }
    })
  })
});
