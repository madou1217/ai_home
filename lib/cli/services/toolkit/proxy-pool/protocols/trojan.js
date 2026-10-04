'use strict';

const { encodeTrojanLink, parseTrojanLink } = require('../protocol-parsers/trojan-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');

module.exports = Object.freeze({
  id: 'trojan',
  capability: 'proxy-pool.protocol',
  name: 'Trojan',
  protocols: Object.freeze(['trojan']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['trojan']),
  // WebUI 节点编辑表单（字段描述）与可提交的协议字段白名单。
  editor: Object.freeze({
    fields: Object.freeze([
      { key: 'password', label: '密码 / 密钥', type: 'password', required: true, requiredMessage: '请输入密码或密钥' },
      { key: 'sni', label: 'SNI / Server name', type: 'text', row: 'tls', placeholder: '可选' },
      { key: 'path', label: '路径', type: 'text', row: 'tls', placeholder: '/ws（可选）' }
    ])
  }),
  nodeFields: Object.freeze(['password', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'serviceName', 'allowInsecure']),
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
