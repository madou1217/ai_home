'use strict';

const { encodeSSLink, parseSSLink } = require('../protocol-parsers/ss-parser');
const { normalizePluginOptions, requiredString } = require('../cores/mihomo/proxy-fields');
const {
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { asObject, optionalString } = require('../protocol-parsers/clash-fields');
const { requiredText, surgeObfsParams } = require('../cores/surge/proxy-fields');
const { loonObfsFields, surgeObfsFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { quantumultXShadowsocksObfs } = require('../cores/surge/quantumult-x-fields');
const { requiredValue } = require('../cores/egern/proxy-fields');

// Egern 把 chacha20-ietf-poly1305 写作 chacha20-poly1305。
const EGERN_METHODS = Object.freeze({ 'chacha20-ietf-poly1305': 'chacha20-poly1305' });
const {
  canonicalShadowsocksPlugin,
  shadowsocksPluginIdentity,
  toClashPlugin,
  toSip003Plugin
} = require('../shadowsocks-plugin');

module.exports = Object.freeze({
  id: 'shadowsocks',
  capability: 'proxy-pool.protocol',
  name: 'Shadowsocks',
  protocols: Object.freeze(['shadowsocks']),
  aliases: Object.freeze(['ss']),
  uriSchemes: Object.freeze(['ss']),
  fields: Object.freeze({ password: 'string', cipher: 'string', plugin: 'string', pluginOpts: 'options' }),
  required: Object.freeze(['cipher', 'password']),
  // 插件的 SIP003 写法与 Clash 写法表示同一连接：身份按中立表示计算。
  connectionIdentity: (node) => ({ plugin: shadowsocksPluginIdentity(node), pluginOpts: undefined }),
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
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['shadowsocks']),
      parse: (outbound) => ({
        cipher: optionalString(outbound.method),
        password: optionalString(outbound.password),
        plugin: optionalString(outbound.plugin),
        pluginOpts: optionalString(outbound.plugin_opts)
      })
    }),
    surge: Object.freeze({
      types: Object.freeze(['ss']),
      parse: ({ params }) => ({
        cipher: optionalString(params['encrypt-method']),
        password: optionalString(params.password),
        ...surgeObfsFields(params)
      })
    }),
    loon: Object.freeze({
      types: Object.freeze(['shadowsocks']),
      parse: ({ args, params }) => ({
        cipher: optionalString(args[2]),
        password: optionalString(args[3]),
        ...loonObfsFields(params)
      })
    }),
    'quantumult-x': Object.freeze({
      types: Object.freeze(['shadowsocks']),
      parse({ params }) {
        const obfs = String(params.obfs || '').trim().toLowerCase();
        const websocket = obfs === 'ws' || obfs === 'wss';
        const pluginOpts = websocket
          ? ['mode=websocket', obfs === 'wss' ? 'tls' : '', params['obfs-host'] ? `host=${params['obfs-host']}` : '',
            params['obfs-uri'] ? `path=${params['obfs-uri']}` : ''].filter(Boolean).join(';')
          : '';
        return {
          cipher: optionalString(params.method),
          password: optionalString(params.password),
          ...(websocket ? { plugin: 'v2ray-plugin', pluginOpts } : surgeObfsFields(params))
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
      const plugin = toClashPlugin(canonicalShadowsocksPlugin(node));
      if (plugin) {
        proxy.plugin = plugin.plugin;
        if (Object.keys(plugin['plugin-opts'] || {}).length) proxy['plugin-opts'] = normalizePluginOptions(plugin['plugin-opts']);
      }
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        method: requireSingBoxString(node.cipher, 'missing_required_proxy_field_cipher'),
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password')
      };
      const plugin = toSip003Plugin(canonicalShadowsocksPlugin(node));
      if (plugin) {
        outbound.plugin = plugin.plugin;
        if (plugin.options) outbound.plugin_opts = plugin.options;
      }
      return outbound;
    },
    surge: (node) => ({
      type: 'ss',
      params: {
        'encrypt-method': requiredText(node, 'cipher'),
        password: requiredText(node, 'password'),
        ...surgeObfsParams(node),
        'udp-relay': true
      }
    }),
    loon(node) {
      const obfs = surgeObfsParams(node);
      return {
        type: 'Shadowsocks',
        args: [requiredText(node, 'cipher'), quoted(requiredText(node, 'password'))],
        params: {
          'obfs-name': obfs.obfs,
          'obfs-host': obfs['obfs-host'],
          'obfs-uri': obfs['obfs-uri'],
          'fast-open': false,
          udp: true
        }
      };
    },
    'quantumult-x': (node) => ({
      type: 'shadowsocks',
      params: {
        method: requiredText(node, 'cipher'),
        password: requiredText(node, 'password'),
        ...quantumultXShadowsocksObfs(node),
        'fast-open': false,
        'udp-relay': true
      }
    }),
    egern(node) {
      const cipher = requiredValue(node, 'cipher');
      const obfs = surgeObfsParams(node);
      return {
        type: 'shadowsocks',
        fields: {
          method: EGERN_METHODS[cipher] || cipher,
          password: requiredValue(node, 'password'),
          obfs: obfs.obfs,
          obfs_host: obfs['obfs-host'],
          obfs_uri: obfs['obfs-uri'],
          udp_relay: true
        }
      };
    }
  })
});
