'use strict';

const { compileMihomoProxy, emitYaml } = require('../../proxy-pool/cores/mihomo/proxy-compiler');
const { supportsUdpRelay } = require('../../proxy-pool/protocols');
const { chainRefOf } = require('../proxy-chain');
const { planRelayBatch, pruneChainFailures } = require('./relay-batch');

/**
 * 本机中转的配置编译（mihomo 内核；纯函数，不碰进程与文件）。
 *
 * 为什么要第二个内核：sing-box 没有 xhttp 传输、没有 VLESS Encryption（ML-KEM）、没有
 * ShadowsocksR / Mieru 出站，这几类节点它编不出来；mihomo 全都能编（实测 `mihomo -t` 通过）。
 * 反过来 naive 只有 sing-box 有。所以两个内核互补，按节点挑能编的那个（见 kernels/）。
 *
 * 形态与 sing-box 那版等价：每个要中转的节点一个 mixed 监听（`listeners[]`，带 `proxy` 字段把
 * 这个监听钉到对应出站），配 `users` 做 SOCKS5/HTTP 认证；链式代理用 `dialer-proxy`。
 * 出站名用 `relay-<节点 id>`：这份配置是边车内部的，不需要和客户端里的节点名一致，
 * 也就顺带避开了重名与逗号/emoji 之类的名字问题。
 */

const DEFAULT_BASE_PORT = 23400;
const DEFAULT_MAX_PORTS = 256;
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const PROXY_PREFIX = 'relay-';
const LISTENER_PREFIX = 'relay-in-';

function proxyName(nodeId) {
  // mihomo 的代理名进 YAML，用 id 而不是节点名（节点名会被改名/去重，还可能带分隔符）。
  return `${PROXY_PREFIX}${String(nodeId).replace(/[^\w.-]/g, '_')}`;
}

/** 节点列表 → mihomo 配置对象。返回 { config, endpoints, skipped }。 */
function compileMihomoRelayConfig(nodes, options = {}) {
  const listenHost = options.listenHost || DEFAULT_LISTEN_HOST;
  const advertiseHost = options.advertiseHost || listenHost;
  const auth = options.auth && options.auth.username ? options.auth : null;
  const maxPorts = Number(options.maxPorts || DEFAULT_MAX_PORTS);
  const onlyIds = options.onlyIds instanceof Set ? options.onlyIds : null;
  const assignPort = options.assignPort || ((_nodeId, index) => Number(options.basePort || DEFAULT_BASE_PORT) + index);
  const { byId, wanted, upstreamIds, skipped } = planRelayBatch(nodes, { onlyIds, maxPorts });

  const ordered = [...wanted].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const endpoints = new Map();
  ordered.forEach((node, index) => {
    endpoints.set(node.id, {
      host: advertiseHost,
      port: Number(assignPort(node.id, index)),
      udp: supportsUdpRelay(node)
    });
  });

  const outboundIds = [...new Set([...ordered.map((node) => node.id), ...upstreamIds])].filter((id) => byId.has(id));
  const compiled = new Map();
  const failed = new Map();
  for (const id of outboundIds) {
    try {
      compiled.set(id, compileMihomoProxy(byId.get(id), proxyName(id), { target: 'mihomo' }));
    } catch (error) {
      failed.set(id, error.code || error.message);
    }
  }
  pruneChainFailures({ byId, compiled, endpoints, failed, skipped });

  const proxies = [];
  for (const [id, proxy] of compiled) {
    // 链式代理：mihomo 用 dialer-proxy 指定经由哪个出站建连；多级链靠上游自己也带。
    const upstream = chainRefOf(byId.get(id));
    proxies.push(upstream && compiled.has(upstream)
      ? { ...proxy, 'dialer-proxy': proxyName(upstream) }
      : proxy);
  }
  const listeners = [];
  for (const [nodeId, endpoint] of endpoints) {
    listeners.push({
      name: `${LISTENER_PREFIX}${nodeId}`,
      type: 'mixed',
      listen: listenHost,
      port: endpoint.port,
      proxy: proxyName(nodeId),
      ...(auth ? { users: [{ username: auth.username, password: auth.password }] } : {})
    });
  }

  const config = {
    'log-level': 'warning',
    mode: 'global',
    proxies,
    listeners
  };
  return { config, endpoints, skipped };
}

/** 与 compileRelayConfig 同样的返回形状，但正文是 YAML 文本。 */
function compileMihomoRelayConfigText(nodes, options = {}) {
  const { config, endpoints, skipped } = compileMihomoRelayConfig(nodes, options);
  return { text: `${emitYaml(config)}\n`, endpoints, skipped };
}

module.exports = {
  DEFAULT_BASE_PORT,
  DEFAULT_LISTEN_HOST,
  DEFAULT_MAX_PORTS,
  LISTENER_PREFIX,
  PROXY_PREFIX,
  compileMihomoRelayConfig,
  compileMihomoRelayConfigText,
  proxyName
};
