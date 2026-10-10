'use strict';

const anytls = require('./anytls');
const http = require('./http');
const hysteria = require('./hysteria');
const hysteria2 = require('./hysteria2');
const shadowsocks = require('./shadowsocks');
const shadowsocksr = require('./shadowsocksr');
const snell = require('./snell');
const socks5 = require('./socks5');
const trojan = require('./trojan');
const tuic = require('./tuic');
const vless = require('./vless');
const vmess = require('./vmess');
const wireguard = require('./wireguard');

/**
 * 代理协议插件注册表（顺序即 URI 匹配顺序）。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability）：
 * - id / name / capability='proxy-pool.protocol'
 * - protocols: 节点上的协议名
 * - aliases: 协议名别名（如 ss → shadowsocks）
 * - uriSchemes: 认领的分享链接 scheme（不含 ://）
 * - fields / required / validate?: 节点字段声明（见 ../protocol-fields）
 * - clientTuning? / connectionIdentity?(node): 连接指纹里排除或改写的字段
 * - udpRelay?: boolean | (node) => boolean，是否能转发 UDP（缺省 true）
 * - singBoxSection?: 'endpoints'，sing-box 输出里写在 endpoints 而不是 outbounds（WireGuard）
 * - imports: { [格式]: { types, parse(entry) → 节点字段 } } 各订阅格式的导入（clash …）
 * - parse(uri) → 节点；encode(node) → 分享链接（没有分享链接格式的协议返回 null / ''）
 * - compile: { [target]: (node, base) => outbound } 各输出目标的出站字段编译
 *   （mihomo / sing-box / surge / loon / quantumult-x，按需实现；缺哪个就在哪个格式里跳过）
 *
 * 新增协议 = 新增一个插件文件并登记到此数组；各输出目标通过 compile[target] 自动获得支持。
 */
const PROTOCOL_PLUGINS = Object.freeze([
  shadowsocks, shadowsocksr, vmess, vless, trojan, hysteria2, hysteria, tuic, anytls, wireguard, snell, socks5, http
]);

const SUPPORTED_PROTOCOLS = new Set(PROTOCOL_PLUGINS.flatMap((plugin) => plugin.protocols));

const PLUGIN_BY_PROTOCOL = new Map(PROTOCOL_PLUGINS.flatMap((plugin) => (
  plugin.protocols.map((protocol) => [protocol, plugin])
)));

const PROTOCOL_ALIASES = new Map(PROTOCOL_PLUGINS.flatMap((plugin) => (
  plugin.aliases.map((alias) => [alias, plugin.protocols[0]])
)));

// 各订阅格式里的类型名 → 插件（插件在 imports.<格式>.types 里认领）。
const PLUGIN_BY_IMPORT_TYPE = new Map(PROTOCOL_PLUGINS.flatMap((plugin) => (
  Object.entries(plugin.imports || {}).flatMap(([format, importer]) => (
    importer.types.map((type) => [`${format}:${String(type).toLowerCase()}`, plugin])
  ))
)));

function findProtocolPluginForImport(format, type) {
  return PLUGIN_BY_IMPORT_TYPE.get(`${format}:${String(type || '').trim().toLowerCase()}`) || null;
}

function normalizeProtocol(protocol) {
  const value = String(protocol || '').trim().toLowerCase();
  return PROTOCOL_ALIASES.get(value) || value;
}

function getProtocolPlugin(protocol) {
  return PLUGIN_BY_PROTOCOL.get(String(protocol || '').trim().toLowerCase()) || null;
}

function supportsUdpRelay(node) {
  const plugin = getProtocolPlugin(normalizeProtocol(node && node.protocol));
  if (!plugin || plugin.udpRelay === undefined) return true;
  return typeof plugin.udpRelay === 'function' ? plugin.udpRelay(node) === true : plugin.udpRelay === true;
}

function findProtocolPluginForUri(link) {
  const text = String(link || '');
  return PROTOCOL_PLUGINS.find((plugin) => plugin.uriSchemes.some((scheme) => text.startsWith(`${scheme}://`))) || null;
}

module.exports = {
  PROTOCOL_PLUGINS,
  SUPPORTED_PROTOCOLS,
  findProtocolPluginForImport,
  findProtocolPluginForUri,
  getProtocolPlugin,
  normalizeProtocol,
  supportsUdpRelay
};
