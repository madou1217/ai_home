'use strict';

const { requiredString } = require('../cores/mihomo/proxy-fields');
const { requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { protocolFieldError } = require('../protocol-fields');
const { optionalString } = require('../protocol-parsers/clash-fields');

// host-key / host-key-algorithms 在 mihomo 与 sing-box 里都是字符串列表。
function textList(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * SSH：mihomo 与 sing-box 都有出站。没有公认的分享链接格式（各家客户端的 ssh:// 写法不一致），
 * 与 Snell 一样只从配置导入、由手动节点表单添加。
 */
module.exports = Object.freeze({
  id: 'ssh',
  capability: 'proxy-pool.protocol',
  name: 'SSH',
  protocols: Object.freeze(['ssh']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze([]),
  fields: Object.freeze({
    username: 'string',
    password: 'string',
    privateKey: 'string',
    privateKeyPassphrase: 'string',
    hostKey: 'string-list',
    hostKeyAlgorithms: 'string-list'
  }),
  required: Object.freeze(['username']),
  validate(node) {
    // 密码与私钥二选一；两者都给时由客户端自己决定优先级。
    if (!node.password && !node.privateKey) throw protocolFieldError('missing_required_proxy_field_password');
  },
  // host-key / host-key-algorithms 在配置里写成列表、手填时写成逗号分隔的字符串：都归一成列表再比指纹。
  connectionIdentity: (node) => ({
    hostKey: textList(node.hostKey),
    hostKeyAlgorithms: textList(node.hostKeyAlgorithms)
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['ssh']),
      parse: (proxy) => ({
        username: optionalString(proxy.username),
        password: optionalString(proxy.password),
        privateKey: optionalString(proxy['private-key']),
        privateKeyPassphrase: optionalString(proxy['private-key-passphrase'] ?? proxy.private_key_passphrase),
        hostKey: textList(proxy['host-key']),
        hostKeyAlgorithms: textList(proxy['host-key-algorithms'])
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['ssh']),
      parse: (outbound) => ({
        username: optionalString(outbound.user),
        password: optionalString(outbound.password),
        privateKey: optionalString(outbound.private_key),
        privateKeyPassphrase: optionalString(outbound.private_key_passphrase),
        hostKey: textList(outbound.host_key),
        hostKeyAlgorithms: textList(outbound.host_key_algorithms)
      })
    })
  }),
  parse: () => null,
  encode: () => '',
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'ssh';
      proxy.username = requiredString(node, 'username');
      if (node.password) proxy.password = String(node.password);
      if (node.privateKey) proxy['private-key'] = String(node.privateKey);
      if (node.privateKeyPassphrase) proxy['private-key-passphrase'] = String(node.privateKeyPassphrase);
      const hostKey = textList(node.hostKey);
      if (hostKey) proxy['host-key'] = hostKey;
      const algorithms = textList(node.hostKeyAlgorithms);
      if (algorithms) proxy['host-key-algorithms'] = algorithms;
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = { ...base, user: requireSingBoxString(node.username, 'missing_required_proxy_field_username') };
      if (node.password) outbound.password = String(node.password);
      if (node.privateKey) outbound.private_key = String(node.privateKey);
      if (node.privateKeyPassphrase) outbound.private_key_passphrase = String(node.privateKeyPassphrase);
      const hostKey = textList(node.hostKey);
      if (hostKey) outbound.host_key = hostKey;
      const algorithms = textList(node.hostKeyAlgorithms);
      if (algorithms) outbound.host_key_algorithms = algorithms;
      return outbound;
    }
  })
});
