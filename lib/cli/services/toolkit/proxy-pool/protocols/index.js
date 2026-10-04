'use strict';

const http = require('./http');
const hysteria2 = require('./hysteria2');
const shadowsocks = require('./shadowsocks');
const socks5 = require('./socks5');
const trojan = require('./trojan');
const vless = require('./vless');
const vmess = require('./vmess');

/**
 * 代理协议插件注册表（顺序即 URI 匹配顺序）。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability）：
 * - id / name / capability='proxy-pool.protocol'
 * - protocols: 节点上的协议名（受支持的运行协议）；legacyProtocols?: 只做解析/编码的旧协议名
 * - aliases: 协议名别名（如 ss → shadowsocks）
 * - uriSchemes: 认领的分享链接 scheme（不含 ://）
 * - parse(uri) → 节点；encode(node) → 分享链接
 * - compile: { [coreId]: (node, base) => outbound } 各内核的出站字段编译（mihomo；sing-box 供 ZCode 出口）
 * - editor: { fields } WebUI 节点编辑表单描述；nodeFields: 可提交的协议字段白名单
 *
 * 新增协议 = 新增一个插件文件并登记到此数组；各内核通过 compile[coreId] 自动获得支持。
 */
const PROTOCOL_PLUGINS = Object.freeze([shadowsocks, vmess, vless, trojan, hysteria2, socks5, http]);

const SUPPORTED_PROTOCOLS = new Set(PROTOCOL_PLUGINS.flatMap((plugin) => plugin.protocols));

const PLUGIN_BY_PROTOCOL = new Map(PROTOCOL_PLUGINS.flatMap((plugin) => [
  ...plugin.protocols,
  ...(plugin.legacyProtocols || [])
].map((protocol) => [protocol, plugin])));

const PROTOCOL_ALIASES = new Map(PROTOCOL_PLUGINS.flatMap((plugin) => (
  plugin.aliases.map((alias) => [alias, plugin.protocols[0]])
)));

function normalizeProtocol(protocol) {
  const value = String(protocol || '').trim().toLowerCase();
  return PROTOCOL_ALIASES.get(value) || value;
}

function getProtocolPlugin(protocol) {
  return PLUGIN_BY_PROTOCOL.get(String(protocol || '').trim().toLowerCase()) || null;
}

function findProtocolPluginForUri(link) {
  const text = String(link || '');
  return PROTOCOL_PLUGINS.find((plugin) => plugin.uriSchemes.some((scheme) => text.startsWith(`${scheme}://`))) || null;
}

/** 供 WebUI 渲染的协议清单（不含函数）。 */
function describeProtocolPlugins() {
  return PROTOCOL_PLUGINS.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    protocols: [...plugin.protocols],
    editor: plugin.editor,
    nodeFields: [...plugin.nodeFields]
  }));
}

module.exports = {
  PROTOCOL_PLUGINS,
  describeProtocolPlugins,
  SUPPORTED_PROTOCOLS,
  findProtocolPluginForUri,
  getProtocolPlugin,
  normalizeProtocol
};
