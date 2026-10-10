'use strict';

// Shadowsocks 插件的两种常见写法统一成一个中立表示，各输出格式从它出发编译，连接身份也按它计算：
//   SIP003（分享链接 / sing-box / Surge 系）：obfs-local、simple-obfs + "obfs=http;obfs-host=…;obfs-uri=…"，
//     v2ray-plugin + "tls;host=…;path=…;mode=websocket"
//   Clash / mihomo：obfs + { mode, host }，v2ray-plugin + { mode, tls, host, path }

const OBFS_NAMES = new Set(['obfs', 'obfs-local', 'simple-obfs']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function pluginOptions(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key)));
  }
  const options = {};
  for (const token of String(value).split(';').map((item) => item.trim()).filter(Boolean)) {
    const separator = token.indexOf('=');
    const key = separator === -1 ? token : token.slice(0, separator);
    if (!key || UNSAFE_KEYS.has(key)) continue;
    options[key] = separator === -1 ? true : token.slice(separator + 1);
  }
  return options;
}

function text(value) {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function enabled(value) {
  return value === true || /^(?:true|1)$/i.test(String(value ?? ''));
}

/**
 * → null（无插件）| { name: 'obfs', mode, host?, uri? } | { name: 'v2ray-plugin', mode, tls, host?, path? }
 *   | { name: <原样>, options }（其它插件按原样保留，由各格式自行决定能否表达）。
 */
function canonicalShadowsocksPlugin(node) {
  const name = String(node && node.plugin || '').trim();
  if (!name) return null;
  const options = pluginOptions(node.pluginOpts);
  if (OBFS_NAMES.has(name)) {
    return {
      name: 'obfs',
      mode: text(options.obfs ?? options.mode),
      host: text(options['obfs-host'] ?? options.host),
      uri: text(options['obfs-uri'] ?? options.uri ?? options.path)
    };
  }
  if (name === 'v2ray-plugin') {
    return {
      name: 'v2ray-plugin',
      mode: text(options.mode) || 'websocket',
      tls: enabled(options.tls),
      host: text(options.host),
      path: text(options.path)
    };
  }
  return { name, options };
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Clash / mihomo 写法：{ plugin, 'plugin-opts' }。 */
function toClashPlugin(canonical) {
  if (!canonical) return null;
  if (canonical.name === 'obfs') {
    return { plugin: 'obfs', 'plugin-opts': withoutUndefined({ mode: canonical.mode, host: canonical.host }) };
  }
  if (canonical.name === 'v2ray-plugin') {
    return {
      plugin: 'v2ray-plugin',
      'plugin-opts': withoutUndefined({ mode: canonical.mode, tls: canonical.tls, host: canonical.host, path: canonical.path })
    };
  }
  return { plugin: canonical.name, 'plugin-opts': canonical.options };
}

/** SIP003 写法（sing-box、分享链接）：{ plugin, options: 'k=v;flag' }。 */
function toSip003Plugin(canonical) {
  if (!canonical) return null;
  const join = (entries) => entries
    .filter(([, value]) => value !== undefined && value !== false && value !== '')
    .map(([key, value]) => (value === true ? key : `${key}=${value}`))
    .join(';');
  if (canonical.name === 'obfs') {
    return {
      plugin: 'obfs-local',
      options: join([['obfs', canonical.mode], ['obfs-host', canonical.host], ['obfs-uri', canonical.uri]])
    };
  }
  if (canonical.name === 'v2ray-plugin') {
    return {
      plugin: 'v2ray-plugin',
      options: join([['mode', canonical.mode], ['tls', canonical.tls], ['host', canonical.host], ['path', canonical.path]])
    };
  }
  return { plugin: canonical.name, options: join(Object.entries(canonical.options)) };
}

/** 连接身份用的稳定表示（键排序、值统一为字符串）。 */
function shadowsocksPluginIdentity(node) {
  const canonical = canonicalShadowsocksPlugin(node);
  if (!canonical) return null;
  const flat = canonical.options ? { name: canonical.name, ...canonical.options } : canonical;
  return Object.fromEntries(Object.entries(flat)
    .filter(([, value]) => value !== undefined && value !== false && value !== '')
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

module.exports = {
  canonicalShadowsocksPlugin,
  shadowsocksPluginIdentity,
  toClashPlugin,
  toSip003Plugin
};
