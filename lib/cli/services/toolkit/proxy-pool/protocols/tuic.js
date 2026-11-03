'use strict';

const { encodeTuicLink, parseTuicLink } = require('../protocol-parsers/tuic-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { buildTls, normalizeAlpn, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { requiredText, surgeTlsParams } = require('../cores/surge/proxy-fields');
const { TLS_FIELDS, protocolFieldError } = require('../protocol-fields');
const { alpnList, clashTls, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { surgeTlsFields } = require('../protocol-parsers/surge-fields');
const { egernTls, requiredValue } = require('../cores/egern/proxy-fields');
const { egernTlsFields } = require('../protocol-parsers/egern-fields');

// TUIC v4 用 token 认证（没有 uuid / password）；mihomo / sing-box / Surge / Egern 都只实现 v5，
// 只有 Stash 与分享链接认得 v4，所以 v4 节点在那些格式里跳过并给出这个原因。
function requireV5(node) {
  if (!node.uuid || !node.password) throw protocolFieldError('unsupported_proxy_protocol_tuic-v4');
}

module.exports = Object.freeze({
  id: 'tuic',
  capability: 'proxy-pool.protocol',
  name: 'TUIC',
  protocols: Object.freeze(['tuic']),
  aliases: Object.freeze(['tuic-v5', 'tuic-v4']),
  uriSchemes: Object.freeze(['tuic']),
  fields: Object.freeze({
    uuid: 'string',
    password: 'string',
    token: 'string',
    congestionControl: 'string',
    udpRelayMode: 'string',
    ...TLS_FIELDS
  }),
  // v5 用 uuid + password，v4 用 token：两者二选一，所以在 validate 里判而不是 required。
  validate(node) {
    if (node.uuid !== undefined || node.password !== undefined) {
      if (!node.uuid) throw protocolFieldError('missing_required_proxy_field_uuid');
      if (!node.password) throw protocolFieldError('missing_required_proxy_field_password');
      return;
    }
    if (!node.token) throw protocolFieldError('missing_required_proxy_field_token');
  },
  // 拥塞控制与 UDP 中继方式由客户端各自选择（服务端都接受），不计入连接指纹；Surge 也不提供这两项。
  clientTuning: Object.freeze(['congestionControl', 'udpRelayMode']),
  form: Object.freeze({
    options: Object.freeze({
      congestionControl: Object.freeze(['bbr', 'cubic', 'new_reno']),
      udpRelayMode: Object.freeze(['native', 'quic'])
    }),
    defaults: Object.freeze({ tls: true, congestionControl: 'bbr', alpn: Object.freeze(['h3']) })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['tuic']),
      parse(proxy) {
        return {
          // v4 只有 token（Stash 的缺省版本），v5 才有 uuid + password。
          ...(proxy.token !== undefined
            ? { token: optionalString(proxy.token) }
            : { uuid: optionalString(proxy.uuid), password: optionalString(proxy.password) }),
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
    }),
    egern: Object.freeze({
      types: Object.freeze(['tuic']),
      parse: (proxy) => ({
        uuid: optionalString(proxy.uuid),
        password: optionalString(proxy.password),
        udpRelayMode: optionalString(proxy.udp_relay_mode),
        alpn: alpnList(proxy.alpn),
        tls: true,
        ...egernTlsFields(proxy)
      })
    })
  }),
  parse: parseTuicLink,
  // v4 只有 token，没有公认的分享链接格式（各家客户端的 tuic:// 写法不一致），只从配置导入。
  encode: (node) => (node.uuid && node.password ? encodeTuicLink(node) : ''),
  // mihomo 与 sing-box 缺省 ALPN 即 h3；Surge 的示例总带 alpn，输出时补上。
  compile: Object.freeze({
    mihomo(node, proxy, options = {}) {
      proxy.type = 'tuic';
      if (node.uuid && node.password) {
        proxy.uuid = String(node.uuid);
        proxy.password = String(node.password);
      } else {
        // TUIC v4：只有 Stash 认得（缺省就是 v4，不能写 version: 5）。
        if (options.target !== 'stash') throw protocolFieldError('unsupported_proxy_protocol_tuic-v4');
        proxy.token = requiredString(node, 'token');
      }
      const alpn = normalizeAlpn(node.alpn);
      if (alpn) proxy.alpn = alpn;
      if (node.congestionControl) proxy['congestion-controller'] = String(node.congestionControl);
      if (node.udpRelayMode) proxy['udp-relay-mode'] = String(node.udpRelayMode);
      if (node.sni) proxy.sni = String(node.sni);
      if (node.allowInsecure || node.insecure) proxy['skip-cert-verify'] = true;
      return proxy;
    },
    'sing-box'(node, base) {
      requireV5(node);
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
    surge: (node) => {
      requireV5(node);
      return {
        type: 'tuic-v5',
        params: {
          uuid: requiredText(node, 'uuid'),
          password: requiredText(node, 'password'),
          alpn: (normalizeAlpn(node.alpn) || ['h3']).join(','),
          ...surgeTlsParams(node)
        }
      };
    },
    egern(node) {
      requireV5(node);
      return {
        type: 'tuic',
        fields: {
          uuid: requiredValue(node, 'uuid'),
          password: requiredValue(node, 'password'),
          udp_relay_mode: node.udpRelayMode || undefined,
          alpn: normalizeAlpn(node.alpn) || ['h3'],
          ...egernTls(node)
        }
      };
    }
  })
});
