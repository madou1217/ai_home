'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const {
  listRefreshableHarnesses,
  refreshAllHarnessModelProjections
} = require('../harness/model-projection-refresh');
const { ACCOUNT_LIFECYCLE_CHANGED } = require('./account-lifecycle-event-types');
const { readCodexGatewayConnection } = require('./codex-gateway-connection');
const { reloadServerRuntimePool } = require('./account-runtime-event-listeners');

// 账号生命周期事件的监听者。
//
// 每个监听者只订阅事实，不关心是谁触发的：新增/导入/删除/启停都会落到
// `account.*`。新增一个消费面 = 在这里多注册一个函数，发布点完全不动。

const DEFAULT_DEBOUNCE_MS = 400;

// 事件动作 → 池里「应该是什么样」。
// 只用来跳过重复重建：WebUI 的启停路由自己已经同步重建过运行池，事件再到监听者时
// 池已经是新状态，再全量重扫一遍账号目录纯属浪费（账号多时是几十次磁盘读）。
const ACTIONS_REMOVING_ACCOUNT = new Set(['disabled', 'deleted']);

function poolReflectsEvent(state, event) {
  const provider = String(event && event.provider || '').trim().toLowerCase();
  const accountRef = String(event && event.accountRef || '').trim();
  if (!state || !provider || !accountRef) return false;
  const pool = state.accounts && state.accounts[provider];
  if (!Array.isArray(pool)) return false;
  const present = pool.some((account) => String(account && account.accountRef || '').trim() === accountRef);
  // 只有「停用/删除 + 已经不在池里」能证明池是新的。
  // 其余动作（新增/导入/启用/更新）一律重建：账号对象里的凭据/模型声明可能整体换过。
  return ACTIONS_REMOVING_ACCOUNT.has(String(event && event.action || '')) && !present;
}

// 生命周期事件 → 重建运行池（state.accounts + 派生索引）。
//
// 运行池是「哪些账号现在能服务」的唯一真相，对外模型目录的可见性、模型→账号倒排
// 索引里的账号实例、路由选号都读它。此前只有运行态事件（recovery/reloadPool）会重建池，
// 于是经 /v0/management/state-index/operational-status 这类管理入口关闭账号后，
// 池里仍留着那个账号，直到下一次运行态事件才消失 —— 事件链在
// `pools <- accounts` 这一环是断的。
function createRuntimePoolLifecycleListener(deps = {}) {
  const state = deps.state;
  const debounceMs = Math.max(0, Number(deps.debounceMs) || DEFAULT_DEBOUNCE_MS);
  const onError = typeof deps.onError === 'function' ? deps.onError : null;
  let timer = null;
  let lastEvent = null;

  function report(error, event) {
    if (onError) {
      try { onError(error, event); } catch (_ignored) {}
      return;
    }
    const provider = String(event && event.provider || '').trim();
    const accountRef = String(event && event.accountRef || '').trim();
    console.warn(`\x1b[33m[aih:pool-reload]\x1b[0m ${provider}#${accountRef}: ${String(error && error.message || error)}`);
  }

  function reloadNow() {
    timer = null;
    const event = lastEvent;
    lastEvent = null;
    if (event && poolReflectsEvent(state, event)) return false;
    try {
      return reloadServerRuntimePool(deps);
    } catch (error) {
      report(error, event);
      return false;
    }
  }

  function listener(event) {
    if (!event || event.type !== ACCOUNT_LIFECYCLE_CHANGED) return;
    lastEvent = event;
    if (timer) return;
    timer = setTimeout(reloadNow, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // 同一事件窗口里的其它监听者（模型投影刷新）必须先让池变成新状态，
  // 否则它拿到的 /v1/models 还是旧口径（刚被关闭的账号仍在目录里）。
  listener.flush = () => {
    if (!timer && !lastEvent) return true;
    return reloadNow();
  };
  return listener;
}

// 把批量导入产生的 N 个事件合并成一次目录重建；同一时间只跑一轮，
// 期间的再次触发只记一个 pending，跑完再补一次。
function createHarnessModelProjectionListener(deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const debounceMs = Math.max(0, Number(deps.debounceMs) || DEFAULT_DEBOUNCE_MS);
  const onError = typeof deps.onError === 'function' ? deps.onError : null;
  const refreshImpl = typeof deps.refreshModelProjections === 'function'
    ? deps.refreshModelProjections
    : refreshAllHarnessModelProjections;
  const harnessIds = Array.isArray(deps.harnessIds) && deps.harnessIds.length
    ? deps.harnessIds.map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)
    : listRefreshableHarnesses();

  let timer = null;
  let running = false;
  let pending = false;
  let lastEvent = null;

  function report(error, event) {
    if (onError) {
      try { onError(error, event); } catch (_ignored) {}
      return;
    }
    const provider = String(event && event.provider || '').trim();
    const accountRef = String(event && event.accountRef || '').trim();
    console.warn(`\x1b[33m[aih:models-refresh]\x1b[0m ${provider}#${accountRef}: ${String(error && error.message || error)}`);
  }

  async function run() {
    timer = null;
    if (!aiHomeDir) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const event = lastEvent;
    try {
      // 先让运行池跟上这次事件：/v1/models 的「可见可用」口径读的就是 state.accounts，
      // 池没同步时刷出来的还是旧目录（被关闭账号的模型仍在）。
      if (typeof deps.beforeRefresh === 'function') {
        try { deps.beforeRefresh(event); } catch (_ignored) {}
      }
      const connection = typeof deps.getGatewayConnection === 'function'
        ? deps.getGatewayConnection()
        : readCodexGatewayConnection(fsImpl, aiHomeDir, '');
      if (!connection || !connection.baseUrl || !connection.apiKey) return;
      const outcome = await refreshImpl({
        fs: fsImpl,
        path: pathImpl,
        aiHomeDir,
        harnessIds,
        connection,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs
      });
      if (outcome && outcome.ok === false && outcome.error !== 'gateway_catalog_empty') {
        report(new Error(`${outcome.error}${outcome.message ? ` (${outcome.message})` : ''}`), event);
        return;
      }
      for (const result of (outcome && outcome.results) || []) {
        // 即使 updated=0 也回调：一次账号动作只产生一行/每 harness 的日志，
        // 是判断「事件确实到达监听者」的唯一现场证据，而不是每次推理都刷屏。
        if (result && result.ok && typeof deps.onRefresh === 'function') {
          try { deps.onRefresh(result, event); } catch (_ignored) {}
        }
        if (result && result.ok === false && result.error !== 'gateway_catalog_empty') {
          report(new Error(`${result.harness}: ${result.error}${result.message ? ` (${result.message})` : ''}`), event);
        }
      }
    } catch (error) {
      report(error, event);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (timer || running) {
      if (running) pending = true;
      return;
    }
    timer = setTimeout(() => { void run(); }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return function onAccountLifecycleChanged(event) {
    // 目录只随「配置层」变化：每次推理成功/限流都会发 account.runtime.changed，
    // 拿它刷模型文件等于给网关自身制造无用请求。这里显式只认生命周期事件，
    // 即使监听者被误挂在 `account.*` 通配上也不会被运行态唤醒。
    if (!event || event.type !== ACCOUNT_LIFECYCLE_CHANGED) return;
    lastEvent = event;
    schedule();
  };
}

// 「账号已经不参与调度」的动作：停用与删除。
// 两者都会让账号从运行池里消失，活动痕迹也必须同时消失。
const ACTIONS_STOPPING_ACTIVITY = new Set(['disabled', 'deleted']);

// 生命周期事件 → 清空账号活动（accountActivity）。
//
// 为什么需要：活动状态是三条来源（网关 attempt / provider hook 回合 / 持久会话轮询）
// 叠加的「标记 + TTL」，天生滞后——停用一个账号后，残留的回合标记最长要 120s 才过期。
// 但停用是配置层的确定性事实：用户刚点完「关闭」再看到「运行中」，就是明确的错误
// 展示。这里在事件到达的同一刻把该账号的活动归零，轮询侧的 isAccountEnabled 闸门
// 负责不让它重新点亮。
function createAccountActivityLifecycleListener(deps = {}) {
  return function onAccountLifecycleChanged(event) {
    if (!event || event.type !== ACCOUNT_LIFECYCLE_CHANGED) return false;
    if (!ACTIONS_STOPPING_ACTIVITY.has(String(event.action || '').trim().toLowerCase())) return false;
    const state = deps.state;
    const activity = state && state.accountActivity;
    if (!activity || typeof activity.resetAccount !== 'function') return false;
    return activity.resetAccount(event.provider, event.accountRef);
  };
}

// 「模型目录可能需要重新探测」的动作：新账号、凭据变更、重新启用。
// 删除/停用不需要：账号已不参与调度，保留上次目录即可（见 webui-model-cache 的留档）。
const ACTIONS_REPROBING_MODELS = new Set(['added', 'imported', 'enabled', 'updated']);

// 生命周期事件 → 模型探测插队。
//
// 为什么需要：后台调度器是「冷账号优先后台补课」，但一次补课仍要等到下一个 tick。
// 新增/导入/启用是确定性事实——用户刚加完账号就想看到模型，不该等几小时。
// 这里只做两件廉价的事：把该账号标进下一批探测（priority），并催一次下一轮；
// 真正的探测仍由调度器串行执行，WebUI 请求不等待，失败退避不受影响。
function createModelProbeLifecycleListener(deps = {}) {
  const requestModelProbe = typeof deps.requestModelProbe === 'function' ? deps.requestModelProbe : null;
  const scheduleModelProbeSoon = typeof deps.scheduleModelProbeSoon === 'function' ? deps.scheduleModelProbeSoon : null;
  return function onAccountLifecycleChanged(event) {
    if (!event || event.type !== ACCOUNT_LIFECYCLE_CHANGED) return false;
    const action = String(event.action || '').trim().toLowerCase();
    if (!ACTIONS_REPROBING_MODELS.has(action)) return false;
    const provider = String(event.provider || '').trim();
    const accountRef = String(event.accountRef || '').trim();
    if (!provider || !accountRef) return false;
    let requested = false;
    if (requestModelProbe) {
      try { requested = requestModelProbe(provider, accountRef) !== false; } catch (_ignored) { requested = false; }
    }
    if (scheduleModelProbeSoon) {
      try { scheduleModelProbeSoon(); } catch (_ignored) { /* 调度器只是提醒，失败不影响事件链 */ }
    }
    return requested;
  };
}

function registerAccountLifecycleEventListeners(hub, deps = {}) {
  if (!hub || typeof hub.on !== 'function') return [];
  // 池同步必须排在投影刷新之前注册，并作为它的前置步骤：投影内容来自
  // /v1/models，而 /v1/models 的可见性读运行池。
  const runtimePoolListener = createRuntimePoolLifecycleListener(deps);
  // 活动清零不依赖任何 I/O，注册在最前面：同一事件窗口里先把「运行中」熄灭，
  // 其它监听者做多慢都不影响用户感知。
  const accountActivityListener = createAccountActivityLifecycleListener(deps);
  return [
    hub.on(ACCOUNT_LIFECYCLE_CHANGED, accountActivityListener),
    hub.on(ACCOUNT_LIFECYCLE_CHANGED, runtimePoolListener),
    // 模型探测插队必须排在池重建之后触发（探测读 state.accounts，池没同步就会
    // 探到旧账号对象/旧凭据）。监听器本身只标优先级，真正执行在下一轮调度。
    hub.on(ACCOUNT_LIFECYCLE_CHANGED, createModelProbeLifecycleListener(deps)),
    hub.on(ACCOUNT_LIFECYCLE_CHANGED, createHarnessModelProjectionListener({
      ...deps,
      beforeRefresh: () => runtimePoolListener.flush()
    }))
  ];
}

module.exports = {
  createAccountActivityLifecycleListener,
  createModelProbeLifecycleListener,
  createHarnessModelProjectionListener,
  createRuntimePoolLifecycleListener,
  registerAccountLifecycleEventListeners,
  poolReflectsEvent
};
