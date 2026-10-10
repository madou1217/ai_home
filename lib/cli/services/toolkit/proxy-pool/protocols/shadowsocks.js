'use strict';

const { encodeSSLink, parseSSLink } = require('../protocol-parsers/ss-parser');
const { normalizePluginOptions, requiredString } = require('../cores/mihomo/proxy-fields');
const {
  normalizePluginOptions: normalizeSingBoxPluginOptions,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { asObject, optionalString } = require('../protocol-parsers/clash-fields');

module.exports = Object.freeze({
  id: 'shadowsocks',
  capability: 'proxy-pool.protocol',
  name: 'Shadowsocks',
  protocols: Object.freeze(['shadowsocks']),
  aliases: Object.freeze(['ss']),
  uriSchemes: Object.freeze(['ss']),
  fields: Object.freeze({ password: 'string', cipher: 'string', plugin: 'string', pluginOpts: 'options' }),
  required: Object.freeze(['cipher', 'password']),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['ss', 'shadowsocks']),
      parse(proxy) {
        const rawOptions = proxy['plugin-opts'];
        // 插件参数只保留标量（v2ray-plugin 的自定义 headers 之类嵌套对象无法通用表达）。
        const pluginOpts = typeof rawOptions === 'string'
          ? optionalString(rawOptions)
          : Object.fromEntries(Object.entries(asObject(rawOptions))
            .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
        return {
          cipher: optionalString(proxy.cipher),
          password: optionalString(proxy.password),
          plugin: optionalString(proxy.plugin),
          pluginOpts: pluginOpts && (typeof pluginOpts === 'string' || Object.keys(pluginOpts).length) ? pluginOpts : undefined
        };
      }
    })
  }),
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
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        method: requireSingBoxString(node.cipher, 'missing_required_proxy_field_cipher'),
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password')
      };
      const plugin = String(node.plugin || '').trim();
      const pluginOptions = normalizeSingBoxPluginOptions(node.pluginOpts);
      if (plugin) outbound.plugin = plugin;
      if (pluginOptions) outbound.plugin_opts = pluginOptions;
      return outbound;
    }
  })
});
