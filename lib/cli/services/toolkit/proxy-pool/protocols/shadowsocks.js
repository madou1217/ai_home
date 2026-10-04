'use strict';

const { encodeSSLink, parseSSLink } = require('../protocol-parsers/ss-parser');
const { normalizePluginOptions, requiredString } = require('../cores/mihomo/proxy-fields');

module.exports = Object.freeze({
  id: 'shadowsocks',
  capability: 'proxy-pool.protocol',
  name: 'Shadowsocks',
  protocols: Object.freeze(['shadowsocks']),
  aliases: Object.freeze(['ss']),
  uriSchemes: Object.freeze(['ss']),
  // WebUI 节点编辑表单（字段描述）与可提交的协议字段白名单。
  editor: Object.freeze({
    fields: Object.freeze([
      { key: 'password', label: '密码 / 密钥', type: 'password', required: true },
      { key: 'cipher', label: '加密方式', type: 'text', required: true, placeholder: 'aes-256-gcm / chacha20-ietf-poly1305' }
    ])
  }),
  nodeFields: Object.freeze(['password', 'cipher', 'plugin', 'pluginOpts']),
  parse: parseSSLink,
  encode: encodeSSLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'ss';
      proxy.cipher = requiredString(node, 'cipher');
      proxy.password = requiredString(node, 'password');
      if (node.plugin) {
        proxy.plugin = String(node.plugin);
        if (node.pluginOpts) proxy['plugin-opts'] = normalizePluginOptions(node.pluginOpts);
      }
      return proxy;
    }
  })
});
