'use strict';

const { encodeAnyTlsLink, parseAnyTlsLink } = require('../protocol-parsers/anytls-parser');
const { requiredString, tlsOptions } = require('../cores/mihomo/proxy-fields');
const { buildTls, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS } = require('../protocol-fields');
const { clashTls, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { insecure, requiredValue } = require('../cores/egern/proxy-fields');
const { egernRealityFields } = require('../protocol-parsers/egern-fields');

module.exports = Object.freeze({
  id: 'anytls',
  capability: 'proxy-pool.protocol',
  name: 'AnyTLS',
  protocols: Object.freeze(['anytls']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['anytls']),
  fields: Object.freeze({ password: 'string', ...TLS_FIELDS }),
  required: Object.freeze(['password']),
  singBoxSince: '1.12.0',
  form: Object.freeze({ defaults: Object.freeze({ tls: true }) }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['anytls']),
      parse: (proxy) => ({ password: optionalString(proxy.password), ...clashTls(proxy, { forceTls: true }) })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['anytls']),
      parse: (outbound) => ({ password: optionalString(outbound.password), ...singBoxTls(outbound, { forceTls: true }) })
    }),
    // Egern 的 AnyTLS 缺省就跳过证书校验：只有显式写 false 才校验（编译方向总是显式写出）。
    // REALITY 如实带出，由节点库按字段声明拒绝，不当成普通 TLS 导入。
    egern: Object.freeze({
      types: Object.freeze(['anytls']),
      parse: (proxy) => ({
        password: optionalString(proxy.password),
        tls: true,
        sni: optionalString(proxy.sni),
        allowInsecure: proxy.skip_tls_verify === false ? undefined : true,
        ...egernRealityFields(proxy.reality)
      })
    })
  }),
  parse: parseAnyTlsLink,
  encode: encodeAnyTlsLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'anytls';
      proxy.password = requiredString(node, 'password');
      tlsOptions(node, proxy);
      // mihomo 的 anytls 用 sni（不是 servername）。
      if (proxy.servername) {
        proxy.sni = proxy.servername;
        delete proxy.servername;
      }
      delete proxy.tls;
      if (node.fingerprint) proxy['client-fingerprint'] = String(node.fingerprint);
      return proxy;
    },
    'sing-box': (node, base) => ({
      ...base,
      password: requireSingBoxString(node.password, 'missing_required_proxy_field_password'),
      tls: buildTls(node, { force: true })
    }),
    egern: (node) => ({
      type: 'anytls',
      fields: {
        password: requiredValue(node, 'password'),
        sni: node.sni || undefined,
        // Egern 的 AnyTLS 不写这一项时跳过证书校验：显式写出，按节点设置决定。
        skip_tls_verify: insecure(node),
        udp_relay: true
      }
    })
  })
});
