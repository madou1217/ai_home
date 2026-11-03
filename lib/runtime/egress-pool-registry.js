'use strict';

// 出口池的进程内单例访问点。
//
// 为什么需要它：出口池由 server 启动时创建（server.js 的启动钩子），但消费方在
// 请求热路径上（transport 的失败分支要轮换出口）。把实例挂在模块级单例上，
// 热路径按需读取，不需要把实例顺着 deps 透传八层 —— 那正是 2026-10-17 那次
// 「账号出口静默失效」事故的成因（某一层漏传即无声回落）。
//
// 单例为空表示本进程没有池（未启用，或这是用户自己启动的 `aih <cli>` 进程）。
// 这时地址解析改读 server 写下的运行文件（egress-pool-state-file）：只有写文件的 server
// 与它登记的内核都存活才采用，否则 fail-closed。轮换/启动只在持有池的 server 进程里发生。

const poolStateFile = require('./egress-pool-state-file');
const {
  clearDisabledNodes,
  describeNodePolicy,
  readNodePolicy,
  writeNodePolicy
} = require('./egress-pool-node-policy');

let current = null;
// 后台补规划的去重与节流：请求路径上只标记「需要规划」，真正的规划在下一个 tick 做。
// 没有它，2w 节点时每个未分配车道的请求都会触发一次全量规划。
let planScheduled = false;
let planInFlight = false;
const PLAN_THROTTLE_MS = 2000;
let lastPlanAt = 0;

/**
 * 请求路径上请求一次后台规划：立即返回，规划在微任务里跑一次。
 * 节流 + 去重，保证并发请求不会各自触发一次全量规划。永不抛。
 */
function scheduleBackgroundPlan(service) {
  if (planScheduled || planInFlight) return false;
  const now = Date.now();
  if (now - lastPlanAt < PLAN_THROTTLE_MS) return false;
  if (!service || typeof service.planNow !== 'function') return false;
  planScheduled = true;
  setImmediate(() => {
    planScheduled = false;
    if (planInFlight) return;
    planInFlight = true;
    lastPlanAt = Date.now();
    try {
      service.planNow();
    } catch (_error) {
      /* 规划失败不影响请求：下次 tick 或下一次请求再补 */
    } finally {
      planInFlight = false;
    }
  });
  return true;
}

/** server 启动时登记；停止时用 setEgressPoolService(null) 注销。 */
function setEgressPoolService(service) {
  current = service && typeof service === 'object' ? service : null;
  return current;
}

function getEgressPoolService() {
  return current;
}

/** 出口池是否就绪（有本地出站地址可用）。 */
function isEgressPoolReady() {
  return Boolean(current && current.ready);
}

/**
 * 池的本地出站地址；未就绪返回 ''。
 * 本进程登记了池服务时只看它；否则（CLI 进程）在给了 aiHomeDir 时读 server 的运行文件。
 * 给了 accountRef 时返回该账号的车道地址（规划器分配，见 egress-pool-runtime 的车道）：
 *   - 账号已分到车道 → 车道地址；车道没有可用节点（如地区全被拒）→ ''（fail-closed，不回落默认出口）；
 *   - 还没分到车道 → **不在请求路径上等规划**：后台补一次规划，本次请求先用默认出口
 *     （2026-10-21：2w 节点规模下同步规划要读全库 + 逐个判定，会把请求卡住；车道是优化不是前置条件）。
 */
function currentEgressPoolProxyUrl(options = {}) {
  const accountRef = String((options && options.accountRef) || '').trim();
  if (current) {
    if (!current.ready) return '';
    const runtime = current.runtime;
    if (accountRef && runtime && typeof runtime.laneProxyUrl === 'function') {
      const lane = runtime.laneProxyUrl(accountRef);
      if (lane !== null) return lane;
      // 还没分到车道：异步补规划，本次走默认出口。
      scheduleBackgroundPlan(current);
    }
    return String(current.proxyUrl || '');
  }
  if (!options || !options.aiHomeDir) return '';
  const live = poolStateFile.readLiveEgressPoolState(options);
  if (!live.state) return '';
  // 本地会话（options.session）且账号是「会话独占」策略：每个会话认领一条不同的会话车道。
  const sessionUrls = accountRef && options.session === true && live.state.sessionLanes
    ? live.state.sessionLanes[accountRef]
    : null;
  if (Array.isArray(sessionUrls) && sessionUrls.length) {
    // eslint-disable-next-line global-require
    const { acquireSessionLane } = require('./egress-pool-session-lease');
    const leased = acquireSessionLane({ fs: options.fs, aiHomeDir: options.aiHomeDir, accountRef, urls: sessionUrls });
    if (leased) return leased.url;
  }
  if (accountRef && live.state.lanes && live.state.lanes[accountRef]) return live.state.lanes[accountRef];
  return live.state.proxyUrl;
}

/**
 * 池为什么不可用（给错误详情用，避免笼统地怪「没有节点或内核未启动」）。可用时返回 ''。
 *   - 本进程有池：启动中 → egress_pool_starting；否则最近一次启动失败的原因；
 *   - 本进程没有池：运行文件给出的原因（server 未运行 / 内核已退出）。
 */
function describeEgressPoolUnavailable(options = {}) {
  if (current) {
    if (current.ready) {
      const runtime = current.runtime;
      const accountRef = String((options && options.accountRef) || '').trim();
      return accountRef && runtime && typeof runtime.laneUnavailableReason === 'function'
        ? runtime.laneUnavailableReason(accountRef)
        : '';
    }
    const status = current.status || {};
    if (status.starting) return 'egress_pool_starting';
    return String(status.lastError || '') || 'egress_pool_not_started';
  }
  if (!options || !options.aiHomeDir) return 'egress_pool_server_not_running';
  return poolStateFile.readLiveEgressPoolState(options).reason;
}

/**
 * 惰性拉起：请求解析到 `pool` 绑定而池未就绪时调用。没有登记服务（CLI 进程、
 * server 未启用池）时安静返回 false。永不抛、不等待 —— 本次请求仍按未就绪 fail-closed。
 */
function ensureEgressPoolStarted() {
  if (!current || typeof current.ensureStarted !== 'function') return false;
  try {
    return Boolean(current.ensureStarted());
  } catch (_error) {
    return false;
  }
}

/**
 * 立即启动并等待结果（WebUI 保存 `pool` 绑定时用：保存即探测，需要池先就绪）。
 * 没有登记服务时返回 { ok:false, error:'egress_pool_unavailable' }。永不抛。
 */
async function startEgressPool() {
  if (!current || typeof current.start !== 'function') {
    return { ok: false, error: 'egress_pool_unavailable' };
  }
  try {
    return await current.start();
  } catch (error) {
    return { ok: false, error: String((error && error.message) || 'egress_pool_start_failed') };
  }
}

/**
 * 轮换到池中下一个出口。返回切换后的节点名；未就绪/无节点返回 ''。
 * fromNode：调用方失败时所用的节点 —— 池已被别的请求切走时不再前进（见 rotateNode）。
 * 永不抛：这是失败路径上的补救动作，它自己出错不该盖住原始的上游错误。
 */
async function rotateEgressPoolNode(fromNode, reason, accountRef) {
  const runtime = current && current.runtime;
  if (!runtime || typeof runtime.rotateNode !== 'function') return '';
  try {
    if (accountRef && typeof runtime.laneOf === 'function' && runtime.laneOf(accountRef)) {
      return await runtime.rotateLane(accountRef, fromNode, reason);
    }
    return await runtime.rotateNode(fromNode, reason);
  } catch (_error) {
    return '';
  }
}

/** 池当前的活动节点名（给了 accountRef 且账号有车道时是车道的活动节点）；未就绪返回 ''。 */
function currentEgressPoolNode(accountRef) {
  const runtime = current && current.runtime;
  if (!runtime || !runtime.ready) return '';
  if (accountRef && typeof runtime.laneOf === 'function' && runtime.laneOf(accountRef)) {
    return String(runtime.laneActiveNode(accountRef) || '');
  }
  const status = runtime.status;
  return status && status.ready ? String(status.activeNode || '') : '';
}

/**
 * 记录一次经出口池节点的请求结果（节点账本：统计、冷却、事件流）。永不抛。
 * outcome = { ok: true } 或 { ok: false, kind: 'free_limit' | 'gate' | 'network' }。
 */
function recordEgressPoolNodeOutcome(node, outcome, context) {
  const runtime = current && current.runtime;
  if (!runtime || typeof runtime.recordNodeOutcome !== 'function') return;
  try {
    runtime.recordNodeOutcome(node, outcome, context);
  } catch (_error) {
    /* 统计失败不影响请求 */
  }
}

/**
 * 出口池面板的完整视图：服务状态 + 节点账本快照。没有登记服务时返回 { available:false }。
 */
function describeEgressPool() {
  if (!current) return { available: false, status: null, nodes: [], events: [], nodePolicy: null };
  const status = current.status || {};
  const runtime = current.runtime;
  const health = runtime && typeof runtime.healthSnapshot === 'function'
    ? runtime.healthSnapshot()
    : { nodes: [], events: [] };
  // 拦截策略与「可用节点数」一起给界面：开关状态、阈值、以及被拦了几个都要能一眼看到。
  const nodePolicy = runtime && typeof runtime.nodePolicySummary === 'function'
    ? runtime.nodePolicySummary()
    : null;
  return { available: true, status, nodes: health.nodes, events: health.events, nodePolicy };
}

/** 读 / 写节点拦截策略（延迟阈值、连不上、手动关闭）。无池时返回 not_ready。永不抛。 */
function runEgressPoolPolicy(action, payload = {}) {
  const service = current;
  const aiHomeDir = service ? String(service.aiHomeDir || '') : '';
  if (!service || !aiHomeDir) return { ok: false, error: 'egress_pool_not_ready' };
  const runtime = service.runtime;
  const fs = service.fs;
  try {
    if (action === 'read') {
      const summary = runtime && typeof runtime.nodePolicySummary === 'function'
        ? runtime.nodePolicySummary()
        : describeNodePolicy(readNodePolicy(fs, aiHomeDir));
      return { ok: true, nodePolicy: summary };
    }
    if (action === 'update') {
      const patch = payload && typeof payload === 'object' ? payload : {};
      const next = writeNodePolicy(fs, aiHomeDir, patch);
      // 策略变了要重新规划车道（被拦的节点要立刻从车道的可用集合里消失）。
      if (service.planNow) { try { service.planNow(); } catch (_error) { /* 规划失败下次对账会补 */ } }
      if (typeof service.reconcile === 'function') { try { service.reconcile({ force: true }); } catch (_error) {} }
      return { ok: true, nodePolicy: describeNodePolicy(next) };
    }
    if (action === 'clear-disabled') {
      const removed = clearDisabledNodes(fs, aiHomeDir);
      if (service.reconcile) { try { service.reconcile({ force: true }); } catch (_error) {} }
      return { ok: true, removed, nodePolicy: describeNodePolicy(readNodePolicy(fs, aiHomeDir)) };
    }
    return { ok: false, error: 'egress_pool_action_unknown' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || 'egress_pool_policy_failed') };
  }
}

/** 面板动作：立即探测（name 为空 = 全部）/ 切到指定节点 / 解除冷却 / 手动关闭或放行节点。永不抛。 */
async function runEgressPoolAction(action, name, options = {}) {
  const runtime = current && current.runtime;
  if (!runtime || !current.ready) return { ok: false, error: 'egress_pool_not_ready' };
  try {
    if (action === 'probe') {
      const results = name ? [{ name, ...(await runtime.probeNode(name)) }] : await runtime.probeDue({ all: true });
      return { ok: true, results };
    }
    if (action === 'select') {
      const selected = await runtime.selectNode(name);
      return selected ? { ok: true, node: selected } : { ok: false, error: 'egress_pool_select_failed' };
    }
    if (action === 'clear-cooldown') {
      return runtime.clearNodeCooldown(name) ? { ok: true } : { ok: false, error: 'egress_pool_node_unknown' };
    }
    if (action === 'block' || action === 'unblock') {
      if (typeof runtime.setNodeBlocked !== 'function') return { ok: false, error: 'egress_pool_action_unknown' };
      return runtime.setNodeBlocked(name, action === 'block', options.reason || '');
    }
    return { ok: false, error: 'egress_pool_action_unknown' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || 'egress_pool_action_failed') };
  }
}

/** 仅供测试：重置单例。 */
function resetEgressPoolServiceForTests() {
  current = null;
}

module.exports = {
  currentEgressPoolNode,
  currentEgressPoolProxyUrl,
  describeEgressPool,
  describeEgressPoolUnavailable,
  ensureEgressPoolStarted,
  getEgressPoolService,
  isEgressPoolReady,
  recordEgressPoolNodeOutcome,
  resetEgressPoolServiceForTests,
  rotateEgressPoolNode,
  runEgressPoolAction,
  runEgressPoolPolicy,
  setEgressPoolService,
  startEgressPool
};
