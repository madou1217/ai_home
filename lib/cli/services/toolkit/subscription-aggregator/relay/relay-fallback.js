'use strict';

const { DEFAULT_LISTEN_HOST } = require('./relay-config');

/**
 * 渲染器侧的「本机中转」回退：把内核认不出的协议改写成指向边车的 socks5 条目。
 *
 * 渲染器只做一次查表 —— 上下文里有没有这个节点的本地入口，由服务层按「客户端内核认不认这个协议」
 * 决定（见 aggregator-service 的 relayCandidates）。渲染器不该自己判断协议支持度，那样每个格式都要
 * 维护一份内核能力表。
 *
 * 为什么必须保留原节点名：策略组与分流规则引用的都是节点名。改名会让用户的自建组、规则集、
 * 以及「按地区自动分组」全部对不上，而 socks5 只是一个传输方式，用户看到的还是同一个节点。
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
  // 与直连时一致：能转发 UDP 的协议才打开，Clash 默认关闭。
  if (endpoint.udp) proxy.udp = true;
  return proxy;
}

module.exports = {
  compileRelayProxyEntry,
  relayEndpointFor
};
