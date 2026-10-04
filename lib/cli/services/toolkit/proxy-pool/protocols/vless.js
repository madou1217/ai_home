'use strict';

const { encodeVLESSLink, parseVLESSLink } = require('../protocol-parsers/vless-parser');
const { requiredString, tlsOptions, transportOptions } = require('../cores/mihomo/proxy-fields');

const { TRANSPORT_OPTIONS } = require('./editor-fields');

module.exports = Object.freeze({
  id: 'vless',
  capability: 'proxy-pool.protocol',
  name: 'VLESS',
  protocols: Object.freeze(['vless']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['vless']),
  // WebUI 节点编辑表单（字段描述）与可提交的协议字段白名单。
  editor: Object.freeze({
    fields: Object.freeze([
      { key: 'uuid', label: 'UUID', type: 'text', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
      { key: 'network', label: '传输网络', type: 'select', row: 'transport', options: TRANSPORT_OPTIONS },
      { key: 'tls', label: 'TLS', type: 'switch', row: 'transport' },
      { key: 'sni', label: 'SNI / Server name', type: 'text', row: 'tls', placeholder: '可选' },
      { key: 'path', label: '路径', type: 'text', row: 'tls', placeholder: '/ws（可选）' }
    ])
  }),
  nodeFields: Object.freeze(['uuid', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'flow', 'security', 'publicKey', 'shortId', 'fingerprint', 'serviceName', 'allowInsecure']),
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
    }
  })
});
