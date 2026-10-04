'use strict';

const { encodeStandardProxyLink, parseStandardProxyLink } = require('../protocol-parsers/standard-parser');

module.exports = Object.freeze({
  id: 'socks5',
  capability: 'proxy-pool.protocol',
  name: 'SOCKS5',
  protocols: Object.freeze(['socks5']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['socks5', 'socks']),
  // WebUI 节点编辑表单（字段描述）与可提交的协议字段白名单。
  editor: Object.freeze({
    fields: Object.freeze([
      { key: 'password', label: '密码（可选）', type: 'password' },
      { key: 'username', label: '用户名（可选）', type: 'text' }
    ])
  }),
  nodeFields: Object.freeze(['username', 'password']),
  parse: parseStandardProxyLink,
  encode: encodeStandardProxyLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'socks5';
      if (node.username) proxy.username = String(node.username);
      if (node.password) proxy.password = String(node.password);
      return proxy;
    }
  })
});
