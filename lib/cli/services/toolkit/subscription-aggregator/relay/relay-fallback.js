'use strict';

const { DEFAULT_LISTEN_HOST } = require('./relay-config');

/**
 * 渲染器侧的「本机中转」回退：把内核认不出的协议改写成指向边车的本地代理条目。
 *
 * 渲染器只做一次查表 —— 上下文里有没有这个节点的本地入口，由服务层按「目标格式 / 客户端内核认不认
 * 这个协议」决定（见 aggregator-service 的 relayCandidates）。渲染器不该自己判断协议支持度，那样每个
 * 格式都要维护一份内核能力表。
 *
 * 为什么必须保留原节点名：策略组与分流规则引用的都是节点名。改名会让用户的自建组、规则集、
 * 以及「按地区自动分组」全部对不上，而 socks5 只是一个传输方式，用户看到的还是同一个节点。
 *
 * 各格式怎么表达「本地入口」由这个模块统一给出：Clash 系是 `type: socks5` 的代理对象，
 * Surge 系是一行 `socks5, 127.0.0.1, <port>`。
 */

/** 这个节点这次是不是走本机中转；不是就返回 null。 */
function relayEndpointFor(context, nodeId) {
  const endpoints = context && context.relay && context.relay.endpoints;
  if (!endpoints || typeof endpoints.get !== 'function') return null;
  return endpoints.get(String(nodeId || '')) || null;
}

/** 本地入口 → Clash 系的 socks5 条目。 */
function compileRelayProxyEntry(entry, endpoint) {
  const proxy = {
    name: entry.name,
    type: 'socks5',
    server: endpoint.host || DEFAULT_LISTEN_HOST,
    port: endpoint.port
  };
  // 客户端在别的机器上时入口要认证（见 relay-credentials），凭据随条目一起下发。
  if (endpoint.username) {
    proxy.username = endpoint.username;
    proxy.password = endpoint.password;
  }
  // 与直连时一致：能转发 UDP 的协议才打开，Clash 默认关闭。
  if (endpoint.udp) proxy.udp = true;
  return proxy;
}

/**
 * 本地入口 → Surge 系代理行的 { type, args, params }（名字由调用方保留，见 formatSurgeLine）。
 * Surge 的 socks5 行就是 `名字 = socks5, <host>, <port>[, <user>, <pass>][, udp-relay=true]`；
 * udp-relay 默认关，边车能转 UDP 时必须显式打开，否则 UDP 流量会静默走直连。
 */
function compileRelaySurgeProxy(endpoint) {
  return {
    type: 'socks5',
    args: [
      endpoint.host || DEFAULT_LISTEN_HOST,
      endpoint.port,
      ...(endpoint.username ? [endpoint.username, endpoint.password] : [])
    ],
    params: endpoint.udp ? { 'udp-relay': true } : {}
  };
}

module.exports = {
  compileRelayProxyEntry,
  compileRelaySurgeProxy,
  relayEndpointFor
};
