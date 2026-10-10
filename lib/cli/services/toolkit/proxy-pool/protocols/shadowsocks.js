'use strict';

const { encodeSSLink, parseSSLink } = require('../protocol-parsers/ss-parser');
const { normalizePluginOptions, requiredString } = require('../cores/mihomo/proxy-fields');
const {
  normalizePluginOptions: normalizeSingBoxPluginOptions,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');

module.exports = Object.freeze({
  id: 'shadowsocks',
  capability: 'proxy-pool.protocol',
  name: 'Shadowsocks',
  protocols: Object.freeze(['shadowsocks']),
  aliases: Object.freeze(['ss']),
  uriSchemes: Object.freeze(['ss']),
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
