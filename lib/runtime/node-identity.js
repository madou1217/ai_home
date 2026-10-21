'use strict';

// 节点标识的**单一真相**（与账号的 accountRef 同一套思路，见 lib/account/account-identity.js）。
//
// 为什么需要（2026-10-22）：节点在各层有三套标识，且没有正式映射 ——
//   ① 节点库 `node_<sha256前12>`：种子含 name，**改名就漂**（链式代理 chain 存的正是它 → 链会断）；
//   ② 出口池运行时 `node-N`：编译成功序号，**每次启动重排**（只配做会话内选择器）；
//   ③ 账本 `协议|服务器|端口`：稳定但**不含凭据**（同地址不同凭据会被误并成一个出口）。
// 于是「冷却/拦截/延迟」这类跨重启、跨层的数据，落在哪套键上都有一处对不上。
//
// 本模块定两个概念，全仓只用这两个：
//   - **nodeKey**（持久真相）：连接身份 —— 协议 + 服务器 + 端口 + 凭据，归一化后哈希。
//     改名不变、重启不变、换凭据才变；与 `buildProxyNodeConnectionKey` **同一个函数**（不新造）。
//     凡是写盘 / 跨进程 / 跨层的引用（冷却、拦截、延迟、链式前置）一律用它。
//   - **nodeRef**（会话内选择器）：出口池的 `node-N`。只在运行时会话内有效，**永不持久化**。
//     它只用于内核组名与当前进程内的轮换；要落盘时必须翻译成 nodeKey（账本已经这样做）。
//
// 人类可读的短号（UI 展示、日志）用 `nodeLabel`：优先节点名，其次服务器:端口。

const { buildProxyNodeConnectionKey } = require('../cli/services/toolkit/proxy-pool/proxy-node-store');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 持久节点标识（连接身份）。改名/重启不变；凭据变化会变（那是另一个出口）。
 * 无有效协议+服务器+端口时返回 ''（调用方应跳过该节点，而不是用名称兜底 —— 名称不稳定）。
 */
function nodeKeyOf(node) {
  if (!node || typeof node !== 'object') return '';
  const protocol = normalizeString(String(node.protocol || '')).toLowerCase();
  const server = normalizeString(String(node.server || '')).toLowerCase();
  const port = Number(node.port);
  if (!protocol || !server || !Number.isInteger(port) || port <= 0) return '';
  try {
    return buildProxyNodeConnectionKey(node);
  } catch (_error) {
    return '';
  }
}

/** 人类可读短号：节点名 → 服务器:端口 → nodeRef。只用于展示与日志，**不作为引用键**。 */
function nodeLabelOf(node, fallback = '') {
  if (node && typeof node === 'object') {
    const name = normalizeString(String(node.name || ''));
    if (name) return name;
    const server = normalizeString(String(node.server || ''));
    const port = Number(node.port);
    if (server && Number.isInteger(port)) return `${server}:${port}`;
  }
  return normalizeString(fallback);
}

/** 节点的持久键是否可用（不可用时调用方要显式处理，不要退回名称）。 */
function isKeyable(node) {
  return nodeKeyOf(node) !== '';
}

module.exports = {
  isKeyable,
  nodeKeyOf,
  nodeLabelOf
};
