'use strict';

// Xray / V2Ray 配置（v2rayN、v2rayNG、Streisand、Happ 导出的 JSON）→ 节点：一份配置 { remarks?, outbounds }，
// 或多份配置组成的数组。直连 / 阻断 / DNS 等非代理出站跳过；服务器与凭据、streamSettings 在这里取一次，
// 其余交给认领该协议的插件（imports.xray，入参 { outbound, target, user, stream }）。

const { parse: parseJsonc } = require('jsonc-parser');
const { formatServerHost } = require('./base-parser');
const { asObject, optionalString } = require('./clash-fields');
const { buildImportedNode, importError } = require('./imported-node');
const { splitWireGuardEndpoint } = require('./wireguard-parser');
const { xrayStream } = require('./xray-fields');

const NON_PROXY_PROTOCOLS = new Set(['freedom', 'blackhole', 'dns', 'loopback']);
// 客户端给主出站起的通用标签（proxy、proxy-2 …），不适合当节点名。
const GENERIC_TAG = /^(?:proxy|outbound|out|default)[-_]?\d*$/i;

function findXrayPlugin(protocol) {
  return require('../protocols').findProtocolPluginForImport('xray', protocol);
}

function isMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 不是 Xray 形状（没有哪个出站带字符串 protocol；sing-box 用的是 type）时返回 null。 */
function readConfigs(text) {
  const errors = [];
  const document = parseJsonc(String(text || ''), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !document || typeof document !== 'object') return null;
  const configs = (Array.isArray(document) ? document : [document])
    .filter((config) => isMap(config) && Array.isArray(config.outbounds));
  const looksLikeXray = configs.some((config) => config.outbounds.some((item) => isMap(item) && typeof item.protocol === 'string'));
  return looksLikeXray ? configs : null;
}

/**
 * 服务器地址与凭据所在的对象：vmess / vless 在 vnext[0] 与它的 users[0]；trojan / shadowsocks 的凭据写在
 * servers[0] 上，socks / http 在 servers[0].users[0]；WireGuard 的服务器是 peers[0].endpoint；
 * 新版 Xray 也允许把这些直接平铺在 settings 里。
 */
function locateServer(settings) {
  if (Array.isArray(settings.vnext)) {
    const server = asObject(settings.vnext[0]);
    return { target: server, user: asObject(Array.isArray(server.users) ? server.users[0] : undefined) };
  }
  if (Array.isArray(settings.servers)) {
    const server = asObject(settings.servers[0]);
    return { target: server, user: Array.isArray(server.users) ? asObject(server.users[0]) : server };
  }
  if (Array.isArray(settings.peers)) {
    const peer = asObject(settings.peers[0]);
    return { target: splitWireGuardEndpoint(peer.endpoint), user: peer };
  }
  return { target: settings, user: settings };
}

/** 节点名：配置的 remarks（同一份配置有多个代理出站时再带上各自的标签），其次非通用的 tag，最后 地址:端口。 */
function nodeName({ remarks, shared }, outbound, target) {
  const tag = optionalString(outbound.tag);
  const label = tag && !GENERIC_TAG.test(tag) ? tag : `${formatServerHost(target.address)}:${target.port}`;
  if (!remarks) return label;
  return shared ? `${remarks} ${label}` : remarks;
}

function convertOutbound(outbound, context) {
  if (!isMap(outbound)) throw importError('invalid_xray_outbound');
  const protocol = String(outbound.protocol || '').trim().toLowerCase();
  const plugin = findXrayPlugin(protocol);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  const { target, user } = locateServer(asObject(outbound.settings));
  const stream = xrayStream(outbound.streamSettings);
  return buildImportedNode({
    plugin,
    name: nodeName(context, outbound, target),
    server: target.address,
    port: target.port,
    fields: plugin.imports.xray.parse({ outbound, target, user, stream })
  });
}

function parseXrayConfigDetailed(text) {
  const configs = readConfigs(text);
  if (!configs) return null;
  const nodes = [];
  const skippedNodes = [];
  for (const config of configs) {
    const remarks = optionalString(config.remarks)?.trim();
    const outbounds = config.outbounds
      .filter((outbound) => !NON_PROXY_PROTOCOLS.has(String(outbound?.protocol || '').trim().toLowerCase()));
    for (const outbound of outbounds) {
      try {
        nodes.push(convertOutbound(outbound, { remarks, shared: outbounds.length > 1 }));
      } catch (error) {
        skippedNodes.push({
          nodeId: null,
          name: remarks || optionalString(outbound?.tag) || null,
          reason: error.code || error.message
        });
      }
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

module.exports = {
  parseXrayConfigDetailed
};
