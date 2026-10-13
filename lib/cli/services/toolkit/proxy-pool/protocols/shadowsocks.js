'use strict';

const { encodeSSLink, parseSSLink } = require('../protocol-parsers/ss-parser');
const { normalizePluginOptions, requiredString } = require('../cores/mihomo/proxy-fields');
const {
  configError,
  requiredString: requireSingBoxString
} = require('../cores/sing-box/outbound-fields');
const { asObject, optionalString } = require('../protocol-parsers/clash-fields');
const { requiredText, surgeError, surgeObfsParams } = require('../cores/surge/proxy-fields');
const { loonObfsFields, surgeObfsFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { quantumultXShadowsocksObfs } = require('../cores/surge/quantumult-x-fields');
const { requiredValue } = require('../cores/egern/proxy-fields');
const { egernObfsFields } = require('../protocol-parsers/egern-fields');
const { plainTcpStream } = require('../protocol-parsers/xray-fields');
const { withExtras } = require('../compile-result');
const { buildShadowTlsOutbound, hiddenTag, readShadowTlsOutbound } = require('../cores/sing-box/shadow-tls');

// sing-box 的 SS 出站支持的插件（中立表示里的名字）。
const SING_BOX_PLUGINS = new Set(['obfs', 'v2ray-plugin']);

// Egern 把 chacha20-ietf-poly1305 写作 chacha20-poly1305。
const EGERN_METHODS = Object.freeze({ 'chacha20-ietf-poly1305': 'chacha20-poly1305' });

// Egern 与 Xray 的简写（chacha20-poly1305、xchacha20-poly1305）导入时还原成通用的 IETF 写法。
const IETF_METHODS = new Map([
  ['chacha20-poly1305', 'chacha20-ietf-poly1305'],
  ['xchacha20-poly1305', 'xchacha20-ietf-poly1305']
]);

function importedMethod(value) {
  const method = optionalString(value);
  return IETF_METHODS.get(method) || method;
}

const {
  SHADOW_TLS,
  canonicalShadowsocksPlugin,
  shadowTlsPluginFields,
  shadowsocksPluginIdentity,
  toClashPlugin,
  toSip003Plugin
} = require('../shadowsocks-plugin');

// Loon 的 ShadowTLS 参数写在代理行上（shadow-tls-password / shadow-tls-sni / shadow-tls-version）。
function loonShadowTlsFields(params) {
  if (params['shadow-tls-password'] === undefined) return null;
  return shadowTlsPluginFields({
    host: optionalString(params['shadow-tls-sni']),
    password: optionalString(params['shadow-tls-password']),
    version: optionalString(params['shadow-tls-version'])
  });
}

// ShadowTLS 与 simple-obfs 互斥：Loon 行上二者只能出现其一。
function loonPluginParams(node) {
  const plugin = canonicalShadowsocksPlugin(node);
  if (plugin && plugin.name === SHADOW_TLS) {
    const password = String(plugin.password || '').trim();
    if (!password) throw surgeError('missing_required_proxy_field_shadowTlsPassword');
    return {
      'shadow-tls-password': quoted(password),
      'shadow-tls-sni': plugin.host || undefined,
      'shadow-tls-version': plugin.version || undefined
    };
  }
  const obfs = surgeObfsParams(node);
  return { 'obfs-name': obfs.obfs, 'obfs-host': obfs['obfs-host'], 'obfs-uri': obfs['obfs-uri'] };
}

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
  // 手动填写的建议值（还能手填）；插件参数见 shadowsocks-plugin.js。
  form: Object.freeze({
    options: Object.freeze({
      cipher: Object.freeze([
        'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
        '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none'
      ]),
      plugin: Object.freeze(['obfs-local', 'v2ray-plugin', 'shadow-tls'])
    }),
    defaults: Object.freeze({ cipher: 'aes-256-gcm' })
  }),
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
      // ShadowTLS 的 ss 出站用 detour 指向同名的 shadowtls 出站，解析器已按 tag 找回来（context.detour）。
      parse(outbound, context = {}) {
        const detour = context.detour;
        const shadowTls = detour && String(detour.type || '').trim().toLowerCase() === 'shadowtls';
        return {
          cipher: optionalString(outbound.method),
          password: optionalString(outbound.password),
          ...(shadowTls
            ? shadowTlsPluginFields(readShadowTlsOutbound(detour))
            : { plugin: optionalString(outbound.plugin), pluginOpts: optionalString(outbound.plugin_opts) })
        };
      }
    }),
    // SIP008 在线配置的条目与 sing-box 出站同名（method / plugin / plugin_opts）。
    sip008: Object.freeze({
      types: Object.freeze(['shadowsocks']),
      parse: (server) => ({
        cipher: optionalString(server.method),
        password: optionalString(server.password),
        plugin: optionalString(server.plugin),
        pluginOpts: optionalString(server.plugin_opts)
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
        ...(loonShadowTlsFields(params) || loonObfsFields(params))
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
    }),
    egern: Object.freeze({
      types: Object.freeze(['shadowsocks']),
      parse: (proxy) => ({
        cipher: importedMethod(proxy.method),
        password: optionalString(proxy.password),
        ...egernObfsFields(proxy)
      })
    }),
    // Xray 的 SS 出站没有 SIP003 插件；套了别的传输层或 TLS 时节点表达不了。
    xray: Object.freeze({
      types: Object.freeze(['shadowsocks']),
      parse({ user, stream }) {
        plainTcpStream(stream);
        return { cipher: importedMethod(user.method), password: optionalString(user.password) };
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
      const canonical = canonicalShadowsocksPlugin(node);
      // ShadowTLS 是独立的传输层出站：ss 出站用 detour 指过去，辅助出站挂在 extras 上由渲染器展开。
      if (canonical && canonical.name === SHADOW_TLS) {
        return withExtras({ ...outbound, detour: hiddenTag(base.tag) }, [buildShadowTlsOutbound(canonical, base)]);
      }
      // sing-box 只实现了 obfs-local 与 v2ray-plugin；别的插件名会让整份配置被拒。
      if (canonical && !SING_BOX_PLUGINS.has(canonical.name)) {
        throw configError(`unsupported_shadowsocks_plugin_${canonical.name}`);
      }
      const plugin = toSip003Plugin(canonical);
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
      return {
        type: 'Shadowsocks',
        args: [requiredText(node, 'cipher'), quoted(requiredText(node, 'password'))],
        params: {
          ...loonPluginParams(node),
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
