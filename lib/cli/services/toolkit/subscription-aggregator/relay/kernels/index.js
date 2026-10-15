'use strict';

const mihomo = require('./mihomo');
const singBox = require('./sing-box');
const { walkChain } = require('../relay-batch');

/**
 * 中转内核注册表（Strategy）。
 *
 * 描述符契约：
 * - id / label / envVar：标识与「用户可以用哪个环境变量点名内核」
 * - configFileName / basePort / maxPorts：边车自己的配置文件与端口段
 * - versionArgs / parseVersion：怎么问内核版本（sing-box `version`、mihomo `-v`）
 * - resolveBinary(options) → { path, source } | null：内核可执行文件在哪（找不到就 fail-closed）
 * - compileNode(node, options)：单节点能不能编出来（候选判定与「这条链归哪个内核」都用它）
 * - compileText(nodes, options) → { text, endpoints, skipped }：整批配置正文
 * - checkArgs / runArgs(configFile, runDir)：内核自己的「校验 / 运行」参数
 * - buildDependentProtocols：可用性取决于内核构建（而不是数据）的协议 —— 配置被内核拒掉时先去掉
 *   它们重试一次，而不是让整批节点陪葬
 *
 * 顺序即优先级：能编的都优先给 sing-box（JSON 配置、check 语义最清晰），编不了才换 mihomo。
 */
const KERNELS = Object.freeze([singBox, mihomo]);

function kernelById(id) {
  return KERNELS.find((kernel) => kernel.id === id) || null;
}

/** 这个内核能不能编出这个节点（探测式，不写任何东西）。 */
function canCompile(kernel, node, options = {}) {
  try {
    kernel.compileNode(node, options);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 把一批节点按内核切开。**同一条链必须落在同一个内核里** —— 否则 detour 指向另一个内核的 tag，
 * 那份配置会被内核拒掉。所以先按「链根」分组，再给每组挑第一个能编出全部成员的内核；
 * 一个都编不出来时交给首选内核，让它在 skipped 里给出真实原因（fail-closed，不静默丢）。
 *
 * → [{ kernel, nodes }]，顺序与 KERNELS 一致。
 */
function splitByKernel(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
  const byId = new Map(list.map((node) => [node.id, node]));
  const groups = new Map();
  for (const node of list) {
    const walk = walkChain(node, byId);
    // 链本身有问题的（成环 / 前置缺失）按单节点处理：内核的 planner 会把它记进 skipped。
    const chain = walk.ok ? walk.chain : [node];
    const root = chain[chain.length - 1].id;
    if (!groups.has(root)) groups.set(root, new Map());
    for (const member of chain) groups.get(root).set(member.id, member);
  }
  const perKernel = new Map(KERNELS.map((kernel) => [kernel.id, new Map()]));
  for (const members of groups.values()) {
    const chainNodes = [...members.values()];
    const chosen = KERNELS.find((kernel) => chainNodes.every((node) => canCompile(kernel, node, options))) || KERNELS[0];
    for (const node of chainNodes) perKernel.get(chosen.id).set(node.id, node);
  }
  return KERNELS
    .map((kernel) => ({ kernel, nodes: [...perKernel.get(kernel.id).values()] }))
    .filter((group) => group.nodes.length > 0);
}

module.exports = {
  KERNELS,
  canCompile,
  kernelById,
  splitByKernel
};
