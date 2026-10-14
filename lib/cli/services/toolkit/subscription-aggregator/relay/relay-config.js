'use strict';

const { compileSingBoxNodeOutbound, singBoxSectionOf } = require('../../proxy-pool/cores/sing-box/node-outbound');
const { supportsUdpRelay } = require('../../proxy-pool/protocols');
const { MAX_CHAIN_DEPTH, chainRefOf } = require('../proxy-chain');

/**
 * 本机中转的配置编译（纯函数，不碰进程与文件）。
 *
 * 背景：Clash Premium 内核（ClashX / Clash for Windows / Clash for Android 原版）只认
 * ss / ssr / vmess / trojan / snell / socks5 / http。配置文件层面无法让它说 VLESS —— 内核里没有那段代码。
 * 能做的是把「协议切换点」挪到本机：AIH 跑一个 sing-box 边车，每个要中转的节点给它一个本地
 * mixed 入口（SOCKS5 + HTTP 同一个端口，只监听 127.0.0.1），Clash 的配置里写
 * `socks5: 127.0.0.1:<port>`。ClashX 只当壳，真正出网的是 sing-box。
 *
 * 链式代理在这里比渲染器那边简单：tag 直接由节点 id 推出来，出站的 detour 指向上游的 tag 即可，
 * 不需要「节点名」那一层解析（节点名会被改名 / 去重，id 不会）。
 */

const DEFAULT_BASE_PORT = 23100;
const DEFAULT_MAX_PORTS = 256;
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DIRECT_TAG = 'relay-direct';
const INBOUND_PREFIX = 'relay-in-';
const OUTBOUND_PREFIX = 'relay-out-';

function inboundTag(nodeId) {
  return `${INBOUND_PREFIX}${nodeId}`;
}

function outboundTag(nodeId) {
  return `${OUTBOUND_PREFIX}${nodeId}`;
}

/** 沿前置向上走，检出成环 / 缺失 / 超长；返回 { ok, chain: [本节点, 前置, 前置的前置…] }。 */
function walkChain(node, byId) {
  const chain = [];
  const seen = new Set();
  let cursor = node;
  while (cursor) {
    if (seen.has(cursor.id)) return { ok: false, reason: 'invalid_proxy_chain_cycle' };
    seen.add(cursor.id);
    chain.push(cursor);
    if (chain.length > MAX_CHAIN_DEPTH + 1) return { ok: false, reason: 'invalid_proxy_chain_too_deep' };
    const ref = chainRefOf(cursor);
    if (!ref) break;
    const upstream = byId.get(ref);
    if (!upstream) return { ok: false, reason: 'invalid_proxy_chain_missing' };
    cursor = upstream;
  }
  return { ok: true, chain };
}

/**
 * 节点列表 → sing-box 配置。
 *
 * 传进来的应当只有「目标格式表达不了、需要中转」的节点；上游如果自己不在名单里也会被补进来
 * （只做 outbound、不给入口），否则 detour 指向不存在的 tag，sing-box 会拒绝整份配置。
 *
 * options.onlyIds 给出「谁要有本地入口」的子集（其余节点只作为链上前置参与编译）。不传就是全部。
 * 这一层是必要的：A 要中转、A 的前置 B 是内核本来就认的协议时，B 不该白开一个端口，但 B 必须
 * 在配置里当出站，否则 A 的 detour 指向不存在的 tag。
 *
 * options.assignPort(nodeId, index) 由调用方注入：端口分配要在真实端口探测之后决定，这里只负责顺序
 * （按节点 id 排序，所以同一批节点每次拿到同一组端口）。
 * 返回 { config, endpoints: Map<nodeId,{host,port,udp}>, skipped: [{nodeId,reason}] }。
 */
function compileRelayConfig(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
  const byId = new Map(list.map((node) => [node.id, node]));
  const listenHost = options.listenHost || DEFAULT_LISTEN_HOST;
  const maxPorts = Number(options.maxPorts || DEFAULT_MAX_PORTS);
  const onlyIds = options.onlyIds instanceof Set ? options.onlyIds : null;
  const assignPort = options.assignPort || ((_nodeId, index) => Number(options.basePort || DEFAULT_BASE_PORT) + index);
  const skipped = [];

  // 1. 先定「谁要有入口」：链本身有问题的（成环 / 前置缺失 / 超长）一律不给，
  //    让渲染器按原有逻辑跳过它 —— 宁可少一个节点，也不要写出会让整份配置被拒的内容。
  const wanted = [];
  for (const node of list) {
    const walk = walkChain(node, byId);
    if (!walk.ok) {
      if (!onlyIds || onlyIds.has(node.id)) skipped.push({ nodeId: node.id, reason: walk.reason });
      continue;
    }
    if (onlyIds && !onlyIds.has(node.id)) continue;
    wanted.push(node);
  }
  const limited = wanted.slice(0, maxPorts);
  for (const node of wanted.slice(maxPorts)) skipped.push({ nodeId: node.id, reason: 'too_many_relay_nodes' });

  // 1b. 链上的前置都要能编出来（哪怕它自己不需要入口），否则 detour 指向不存在的 tag。
  //     只沿「要有入口的节点」向上收，避免为没人用的节点白编出站。
  const upstreamIds = new Set();
  const pending = limited.map((node) => node.id);
  while (pending.length) {
    const walk = walkChain(byId.get(pending.shift()), byId);
    if (!walk.ok) continue;
    for (const upstream of walk.chain.slice(1)) {
      if (upstreamIds.has(upstream.id)) continue;
      upstreamIds.add(upstream.id);
      pending.push(upstream.id);
    }
  }

  // 2. 端口按节点 id 排序分配：同一批节点每次得到同一组端口，客户端缓存过的配置不会错位。
  const ordered = [...limited].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const endpoints = new Map();
  ordered.forEach((node, index) => {
    endpoints.set(node.id, {
      host: listenHost,
      port: Number(assignPort(node.id, index)),
      udp: supportsUdpRelay(node)
    });
  });

  // 3. 出站：要中转的节点 + 只作为上游被引用的节点。
  const outboundIds = [...new Set([...ordered.map((node) => node.id), ...upstreamIds])].filter((id) => byId.has(id));
  const compiled = new Map();
  const failed = new Map();
  for (const id of outboundIds) {
    try {
      compiled.set(id, compileSingBoxNodeOutbound(byId.get(id), outboundTag(id), { version: options.version }));
    } catch (error) {
      failed.set(id, error.code || error.message);
    }
  }
  // 上游编不出来、或压根不在名单里的，依赖它的节点也一起剔除：丢掉前置会让流量从出口节点直连，
  // 等于漏真实 IP。剔除会沿链传递（A→B→C，C 被剔除则 B 也不留）。
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...compiled.keys()]) {
      const upstream = chainRefOf(byId.get(id));
      if (upstream && !compiled.has(upstream)) {
        failed.set(id, 'unsupported_proxy_chain_upstream_skipped');
        compiled.delete(id);
        changed = true;
      }
    }
  }
  for (const id of failed.keys()) {
    // 只有本来要有入口的节点才值得报给调用方；纯链上前置编不出来时，受影响的是它的下游。
    const hadEndpoint = endpoints.delete(id);
    if (hadEndpoint && !skipped.some((item) => item.nodeId === id)) skipped.push({ nodeId: id, reason: failed.get(id) });
  }

  const inbounds = [];
  const rules = [];
  for (const [nodeId, endpoint] of endpoints) {
    inbounds.push({ type: 'mixed', tag: inboundTag(nodeId), listen: listenHost, listen_port: endpoint.port });
    rules.push({ inbound: [inboundTag(nodeId)], outbound: outboundTag(nodeId) });
  }
  const outbounds = [];
  const endpointsSection = [];
  for (const [id, item] of compiled) {
    // 链式代理：出站先经由上游节点的出站建连；多级链靠上游自己也带 detour。
    const upstream = chainRefOf(byId.get(id));
    const chained = upstream && compiled.has(upstream) ? { ...item, detour: outboundTag(upstream) } : item;
    if (singBoxSectionOf(chained) === 'endpoints') endpointsSection.push(chained);
    else outbounds.push(chained);
  }

  const config = {
    log: { level: 'warn', timestamp: true, ...(options.logPath ? { output: options.logPath } : {}) },
    inbounds,
    outbounds: [...outbounds, { type: 'direct', tag: DIRECT_TAG }],
    ...(endpointsSection.length ? { endpoints: endpointsSection } : {}),
    route: { rules, final: DIRECT_TAG }
  };
  return { config, endpoints, skipped };
}

module.exports = {
  DEFAULT_BASE_PORT,
  DEFAULT_LISTEN_HOST,
  DEFAULT_MAX_PORTS,
  DIRECT_TAG,
  compileRelayConfig,
  inboundTag,
  outboundTag,
  walkChain
};
