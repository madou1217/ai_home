'use strict';

// 出口池的节点来源：从用户已有的代理池（proxy-pool.json）取节点。
//
// 为什么复用代理池而不是另建一套订阅：用户已经用订阅聚合器维护着一份节点库，
// 出口池只是**消费**它 —— 用户换订阅、加节点，出口池下次启动自然跟上，
// 不需要用户为出口池再做一次配置。这是「应用适配用户」而非「用户适配应用」。
//
// 读失败一律返回 { ok:false, error }，由调用方安静降级（出口池是增强能力）。

const { getProxyNodeStore } = require('../cli/services/toolkit/proxy-pool/proxy-node-store');

// 出口池只接受能编译成 mihomo 出站的节点。协议白名单不做硬编码 ——
// 交给 compileMihomoProxy 判定（它才是协议能力的单一事实来源），
// 这里只做形状预筛，避免把明显不可用的条目带进池子。
//
// 除了形状，还挡掉「永远连不上」的地址：机场用占位地址写提示节点
// （实测 `📢暂不支持clash和singbox` → 192.0.2.1:1，RFC 5737 文档保留网段；
// `一元机场.asia` → 0.0.0.0）。它们在池子里只会被反复探测、在账号出口列表里占行。
function isRoutableServer(server) {
  const host = String(server || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  // 明文 IP 才判定保留网段；域名一律放行（DNS 解析与连通性由探测负责）。
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('169.254.')) return false;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(host)) return false;
  return true;
}

function isUsableNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (!isRoutableServer(node.server)) return false;
  const port = Number(node.port);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/**
 * 读取代理池节点。
 *
 * @returns {{ ok: true, nodes: Array }|{ ok: false, error: string }}
 */
function readProxyPoolNodes(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return { ok: false, error: 'egress_pool_ai_home_missing' };

  let store;
  try {
    store = typeof options.getProxyNodeStore === 'function'
      ? options.getProxyNodeStore(options)
      : getProxyNodeStore({ fs: options.fs, aiHomeDir, env: options.env });
  } catch (error) {
    return {
      ok: false,
      error: `egress_pool_store_unavailable:${String((error && error.message) || error || '')}`
    };
  }

  let nodes;
  try {
    // 停用的订阅源不进出口池：节点留在库里，随时可在订阅源里重新启用。
    const disabled = new Set(
      (store.listSubscriptions ? store.listSubscriptions() : [])
        .filter((item) => item && item.enabled === false)
        .map((item) => item.id)
    );
    nodes = store.listNodes().filter((node) => !disabled.has(node.subscriptionId));
  } catch (error) {
    return {
      ok: false,
      error: `egress_pool_nodes_read_failed:${String((error && error.message) || error || '')}`
    };
  }

  const usable = dedupeByExit(
    (Array.isArray(nodes) ? nodes : [])
      .filter(isUsableNode)
      // 信息行不是节点：进池只会被探测、被轮换、在账号出口列表里占一行（见 isInformationalNode）。
      .filter((node) => !isInformationalNode(node))
  );
  if (usable.length === 0) return { ok: false, error: 'egress_pool_no_nodes' };
  return { ok: true, nodes: usable };
}

/**
 * 同一出口只留一个节点。订阅常把「剩余流量 / 距离重置 / 套餐到期」这类信息行做成
 * 指向同一服务器的节点（实测 4 条全是 direct-us-01:36699）。池里留着它们，轮换就会
 * 在同一个被限的 IP 上连跳好几次、把跳数白白耗光（2026-10-18：node-0~3 全 403，
 * node-4 起全 200，网关却跳满 6 次落到 CLI 兜底）。出口 = 协议 + 服务器 + 端口 + 凭据。
 *
 * 去重时**优先保留真实节点名**：`剩余流量：100 GB` 与真实节点指向同一出口
 * （实测 direct-us-01.inetsnode.de:36699），谁先出现谁留下，于是用户看到的是那一行
 * 提示语而不是机器名。把信息行排到后面再按出口去重，留下的就是能认出是哪台的名字。
 */
function exitKey(node) {
  const credential = node.uuid || node.password || node.username || '';
  return [node.protocol, String(node.server || '').trim().toLowerCase(), Number(node.port), credential].join('|');
}

function dedupeByExit(nodes) {
  const seen = new Set();
  const ordered = nodes.slice().sort(
    (a, b) => Number(isInformationalNode(a)) - Number(isInformationalNode(b))
  );
  return ordered.filter((node) => {
    const key = exitKey(node);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 机场常把「剩余流量 / 距离重置 / 套餐到期 / 官网」这类提示塞成假节点
 * （实测 785 个节点里混着 `64.48 GB | 300 GB`、`Traffic Reset: 25 Days Left`、
 * `Expire Date: 2027-03-14`、`剩余流量：100 GB`、`📢暂不支持clash和singbox`）。
 * 聚合订阅早就默认排除它们（subscription-aggregator 的 DEFAULT_EXCLUDE_PATTERN），
 * 但那套规则只作用于**渲染输出**；出口池直接读节点库，这些条目照样进池、照样被探测、
 * 在账号出口里显示成一行「节点」。
 *
 * 排除清单的单一来源仍是聚合器目录，这里只复用，不另立一套规则。
 */
let cachedInfoPattern = null;
function informationalPattern() {
  if (!cachedInfoPattern) {
    // 延迟加载：保持 runtime → cli/services 的方向，避免模块初始化期成环。
    // eslint-disable-next-line global-require
    const { DEFAULT_EXCLUDE_PATTERN } = require('../cli/services/toolkit/subscription-aggregator/catalog');
    cachedInfoPattern = new RegExp(DEFAULT_EXCLUDE_PATTERN, 'i');
  }
  return cachedInfoPattern;
}

function isInformationalNode(node) {
  const name = String((node && node.name) || '').trim();
  if (!name) return false;
  return informationalPattern().test(name);
}

/**
 * 出口池的节点目录：可用节点 + 订阅聚合的自建分组（展开成出口身份集合）。
 * 分组读失败不影响节点（分组是可选的选择手段）。
 *
 * @returns {{ ok: true, nodes: Array, groups: Array<{ id, name, profileName, identities: string[] }> } | { ok:false, error }}
 */
function readEgressPoolCatalog(options = {}) {
  const source = readProxyPoolNodes(options);
  if (!source.ok) return source;
  let groups = [];
  try {
    const { exitIdentity } = require('./egress-pool-node-health');
    const { listAggregatorGroups } = require('../cli/services/toolkit/subscription-aggregator/group-nodes');
    const { getSubscriptionAggregatorStore } = require('../cli/services/toolkit/subscription-aggregator/profile-store');
    const storeOptions = { fs: options.fs, aiHomeDir: options.aiHomeDir, env: options.env };
    const nodeStore = typeof options.getProxyNodeStore === 'function'
      ? options.getProxyNodeStore(options)
      : getProxyNodeStore(storeOptions);
    const profiles = typeof options.listAggregatorProfiles === 'function'
      ? options.listAggregatorProfiles()
      : getSubscriptionAggregatorStore(storeOptions).listProfiles();
    const sources = (nodeStore.listSubscriptions ? nodeStore.listSubscriptions() : []).map((item) => ({ id: item.id, name: item.name }));
    groups = listAggregatorGroups(profiles, sources, nodeStore.listNodes()).map((group) => ({
      id: group.id,
      name: group.name,
      profileName: group.profileName,
      identities: [...new Set(group.nodes.map(exitIdentity).filter(Boolean))]
    }));
  } catch (_error) {
    groups = [];
  }
  return { ok: true, nodes: source.nodes, groups };
}

module.exports = {
  dedupeByExit,
  isInformationalNode,
  isRoutableServer,
  isUsableNode,
  readEgressPoolCatalog,
  readProxyPoolNodes
};
