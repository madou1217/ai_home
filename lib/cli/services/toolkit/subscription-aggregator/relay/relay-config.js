'use strict';

const { compileSingBoxNodeOutbound, singBoxSectionOf } = require('../../proxy-pool/cores/sing-box/node-outbound');
const { supportsUdpRelay } = require('../../proxy-pool/protocols');
const { chainRefOf } = require('../proxy-chain');
const { planRelayBatch, pruneChainFailures, walkChain } = require('./relay-batch');

/**
 * 本机中转的配置编译（sing-box 内核；纯函数，不碰进程与文件）。
 *
 * 背景：有的客户端内核只认一部分协议（Clash Premium 没有 VLESS，Surge 连 VLESS 这一档都没有）。
 * 配置文件层面无法让它说 VLESS —— 内核里没有那段代码。能做的是把「协议切换点」挪到本机：
 * AIH 跑一个内核边车，每个要中转的节点给它一个本地 mixed 入口（SOCKS5 + HTTP 同一个端口），
 * 客户端配置里写 `socks5: <host>:<port>`。客户端只当壳，真正出网的是边车。
 *
 * 地址与鉴权：
 * - `listenHost` 是边车真正绑定的地址。仅本机使用时是 127.0.0.1；客户端在别的机器上时必须绑
 *   可达地址（默认 0.0.0.0），此时**必须**带 `auth`，否则等于在公网开一个无认证代理。
 * - `advertiseHost` 是写进客户端配置的地址（客户端要能连到它）：远端拉订阅时等于客户端用的 Host，
 *   本机请求时是 127.0.0.1。
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

/**
 * 节点列表 → sing-box 配置。
 *
 * options.assignPort(nodeId, index) 由调用方注入：端口分配要在真实端口探测之后决定，这里只负责顺序
 * （按节点 id 排序，所以同一批节点每次拿到同一组端口）。
 * 返回 { config, endpoints: Map<nodeId,{host,port,udp}>, skipped: [{nodeId,reason}] }。
 */
function compileRelayConfig(nodes, options = {}) {
  const listenHost = options.listenHost || DEFAULT_LISTEN_HOST;
  const advertiseHost = options.advertiseHost || listenHost;
  const auth = options.auth && options.auth.username ? options.auth : null;
  const maxPorts = Number(options.maxPorts || DEFAULT_MAX_PORTS);
  const onlyIds = options.onlyIds instanceof Set ? options.onlyIds : null;
  const assignPort = options.assignPort || ((_nodeId, index) => Number(options.basePort || DEFAULT_BASE_PORT) + index);
  const { byId, wanted, upstreamIds, skipped } = planRelayBatch(nodes, { onlyIds, maxPorts });

  // 2. 端口按节点 id 排序分配：同一批节点每次得到同一组端口，客户端缓存过的配置不会错位。
  const ordered = [...wanted].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const endpoints = new Map();
  ordered.forEach((node, index) => {
    endpoints.set(node.id, {
      host: advertiseHost,
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
      compiled.set(id, compileSingBoxNodeOutbound(byId.get(id), outboundTag(id), {
        version: options.version,
        // 边车是用户机器上的完整内核：naive 出站也照编（只有带 libcronet 的构建认它，编不出来会被
        // 内核 check 拒掉，那时按「构建相关协议」降级重试一次，见 kernels/sing-box.js）。
        officialApp: options.officialApp !== false
      }));
    } catch (error) {
      failed.set(id, error.code || error.message);
    }
  }
  pruneChainFailures({ byId, compiled, endpoints, failed, skipped });

  const inbounds = [];
  const rules = [];
  for (const [nodeId, endpoint] of endpoints) {
    inbounds.push({
      type: 'mixed',
      tag: inboundTag(nodeId),
      listen: listenHost,
      listen_port: endpoint.port,
      // 绑到非回环地址时必须有认证，否则等于在公网开一个无认证代理。
      ...(auth ? { users: [{ username: auth.username, password: auth.password }] } : {})
    });
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
