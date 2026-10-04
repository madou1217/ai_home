'use strict';

const { encodeVMessLink, parseVMessLink } = require('../protocol-parsers/vmess-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');
const {
  buildTls,
  buildTransport,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');

const { TRANSPORT_OPTIONS } = require('./editor-fields');

module.exports = Object.freeze({
  id: 'vmess',
  capability: 'proxy-pool.protocol',
  name: 'VMess',
  protocols: Object.freeze(['vmess']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['vmess']),
  // WebUI 节点编辑表单（字段描述）与可提交的协议字段白名单。
  editor: Object.freeze({
    fields: Object.freeze([
      { key: 'uuid', label: 'UUID', type: 'text', required: true, requiredMessage: '请输入 UUID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
      { key: 'network', label: '传输网络', type: 'select', row: 'transport', options: TRANSPORT_OPTIONS },
      { key: 'tls', label: 'TLS', type: 'switch', row: 'transport' },
      { key: 'sni', label: 'SNI / Server name', type: 'text', row: 'tls', placeholder: '可选' },
      { key: 'path', label: '路径', type: 'text', row: 'tls', placeholder: '/ws（可选）' }
    ])
  }),
  nodeFields: Object.freeze(['uuid', 'cipher', 'alterId', 'network', 'tls', 'sni', 'path', 'host', 'type', 'alpn', 'serviceName', 'allowInsecure']),
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
