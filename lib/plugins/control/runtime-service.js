'use strict';

// 服务端独占的 Plugin Host 生命周期：发布代次、按在途请求退役旧代次、崩溃重启、按代数回收宿主进程。
//
// 发布协议（publish）按规划 §5：
//   prepare 候选代次（被拒 → 带诊断失败，旧代次不受影响）
//   → commit 回调（控制面以 expectedRevision 做 CAS；冲突 → 只丢弃候选，旧代次继续服务）
//   → activate（宿主切换活跃代次，但保留旧代次）
// 所有发布在一个队列里串行执行。
//
// 代次固定：网关请求开始时 acquire() 拿到当时的不可变快照与租约，整个请求只调用这一代；
// 发布新代次后，旧代次在最后一个租约释放时才卸载（超过排空时限则强制卸载并记录）。
//
// 没有任何启用实例时不启动宿主进程（M0 冻结门槛）。启动时的恢复是异步的，失败只把状态记为
// degraded 并附带诊断，绝不拖累网关启动。宿主意外退出按退避重启并恢复上一次的期望状态，
// 连续失败超过上限停在 degraded，不无限重拉。
// 代次轮换的模块内存不可回收（M0 报告 §4.1）：宿主上累计准备的代数达到阈值、且没有在途租约时，
// 下一次发布前先重启宿主。

const { PluginError } = require('../sdk/errors');
const { createPluginHostSupervisor } = require('../host/supervisor');
const { collectCatalogAliases } = require('../gateway/catalog');

const DEFAULT_BACKOFF_MS = Object.freeze([500, 1000, 2000, 5000, 10000]);
// 网关请求（含长时间流式输出）持有代次的上限；超过后旧代次被强制卸载。
const DEFAULT_RETIRE_TIMEOUT_MS = 10 * 60 * 1000;
const EMPTY_SNAPSHOT = Object.freeze({ generation: 0, byCapability: new Map(), catalogAliases: Object.freeze([]) });

// 由清单推导出代次的贡献项快照：按能力分组，组内按 order、instanceId、贡献 id 稳定排序。
function buildSnapshot(generation, plugins, extra = {}) {
  const items = [];
  for (const plugin of plugins) {
    for (const contribution of plugin.manifest.contributes || []) {
      items.push(Object.freeze({
        id: contribution.id,
        capability: contribution.capability,
        order: Number(contribution.order || 0),
        failurePolicy: contribution.failurePolicy === 'delegate' ? 'delegate' : 'deny',
        instanceId: plugin.instanceId
      }));
    }
  }
  items.sort((left, right) => left.order - right.order
    || left.instanceId.localeCompare(right.instanceId)
    || left.id.localeCompare(right.id));
  const byCapability = new Map();
  for (const item of items) {
    if (!byCapability.has(item.capability)) byCapability.set(item.capability, []);
    byCapability.get(item.capability).push(item);
  }
  for (const [capability, list] of byCapability) byCapability.set(capability, Object.freeze(list));
  return Object.freeze({ generation, byCapability, catalogAliases: extra.catalogAliases || Object.freeze([]) });
}

function createPluginRuntimeService(options = {}) {
  const supervisorFactory = options.supervisorFactory || ((supervisorOptions) => createPluginHostSupervisor(supervisorOptions));
  const desiredPlugins = typeof options.desiredPlugins === 'function' ? options.desiredPlugins : () => [];
  const recycleAfterGenerations = Math.max(1, Number(options.recycleAfterGenerations || 32));
  const retireTimeoutMs = Math.max(1, Number(options.retireTimeoutMs || DEFAULT_RETIRE_TIMEOUT_MS));
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length ? options.backoffMs : DEFAULT_BACKOFF_MS;
  const maxConsecutiveFailures = Math.max(1, Number(options.maxConsecutiveFailures || backoffMs.length));
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timers = options.timers || { setTimeout, clearTimeout };

  let supervisor = null;
  let phase = 'idle';
  let generation = 0;
  let snapshot = EMPTY_SNAPSHOT;
  let generationsOnHost = 0;
  let diagnostics = [];
  let lastError = null;
  let restarts = 0;
  let consecutiveFailures = 0;
  let forcedRetirements = 0;
  let lastExit = null;
  let stopping = false;
  let restartTimer = null;
  let queue = Promise.resolve();
  // generation → 在途租约数；retiring：已被替换、等租约归零后卸载的代次 → 强制卸载计时器。
  const leases = new Map();
  const retiring = new Map();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function ensureSupervisor() {
    if (supervisor) return supervisor;
    supervisor = supervisorFactory({
      aiHomeDir: options.aiHomeDir,
      socketPath: options.socketPath,
      hostVersion: options.hostVersion,
      env: options.env,
      onLog: options.onHostLog,
      onExit: onHostExit
    });
    return supervisor;
  }

  function clearHostGenerations() {
    snapshot = EMPTY_SNAPSHOT;
    generationsOnHost = 0;
    for (const timer of retiring.values()) timers.clearTimeout(timer);
    retiring.clear();
  }

  function onHostExit(exit) {
    lastExit = exit;
    clearHostGenerations();
    if (stopping) return;
    restarts += 1;
    phase = 'restarting';
    log({ event: 'plugin_host_exited', ...exit });
    scheduleRecovery();
  }

  function scheduleRecovery() {
    if (restartTimer || stopping) return;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      phase = 'degraded';
      log({ event: 'plugin_host_recovery_exhausted', consecutiveFailures });
      return;
    }
    const delay = backoffMs[Math.min(consecutiveFailures, backoffMs.length - 1)];
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      void recover();
    }, delay);
    restartTimer?.unref?.();
  }

  async function recover() {
    try {
      await publish(desiredPlugins(), null);
    } catch (error) {
      consecutiveFailures += 1;
      lastError = { code: error.code || 'plugin_runtime_error', message: error.message, diagnostics: error.diagnostics || [] };
      phase = 'degraded';
      scheduleRecovery();
    }
  }

  async function stopHost() {
    if (!supervisor) return;
    stopping = true;
    try { await supervisor.stop(); } finally { stopping = false; }
    clearHostGenerations();
  }

  function disposeGeneration(target, reason) {
    const timer = retiring.get(target);
    if (timer) timers.clearTimeout(timer);
    retiring.delete(target);
    leases.delete(target);
    if (!supervisor) return;
    supervisor.call('dispose', { generation: target }).then(
      () => log({ event: 'plugin_generation_retired', generation: target, reason }),
      (error) => log({ event: 'plugin_generation_retire_failed', generation: target, message: error.message })
    );
  }

  function retire(target) {
    if (!target) return;
    if (!leases.get(target)) {
      disposeGeneration(target, 'drained');
      return;
    }
    const timer = timers.setTimeout(() => {
      forcedRetirements += 1;
      disposeGeneration(target, 'retire_timeout');
    }, retireTimeoutMs);
    timer?.unref?.();
    retiring.set(target, timer);
  }

  function rejection(prepared) {
    const error = new PluginError('plugin_candidate_rejected', (prepared.diagnostics || []).map((item) => item.detail || item.code).join('；') || '候选代次被拒绝');
    error.diagnostics = prepared.diagnostics || [];
    return error;
  }

  function totalLeases() {
    let total = 0;
    for (const count of leases.values()) total += count;
    return total;
  }

  /**
   * @param {Array<{instanceId, manifest, entryPath, configuration}>} plugins 期望启用的完整集合
   * @param {(() => unknown) | null} commit 控制面提交（CAS）；为 null 时只按现状恢复
   */
  function publish(plugins, commit) {
    return enqueue(async () => {
      const list = Array.isArray(plugins) ? plugins : [];
      if (list.length === 0) {
        if (commit) await commit();
        const previous = snapshot.generation;
        snapshot = EMPTY_SNAPSHOT;
        // 还有请求持有旧代次时先让它们跑完，再停宿主。
        if (previous && leases.get(previous)) {
          retire(previous);
          phase = 'idle';
        } else {
          await stopHost();
          phase = 'idle';
        }
        diagnostics = [];
        consecutiveFailures = 0;
        return { state: 'idle', generation: 0 };
      }
      const host = ensureSupervisor();
      if (generationsOnHost >= recycleAfterGenerations && totalLeases() === 0) {
        log({ event: 'plugin_host_recycle', generationsOnHost });
        await stopHost();
      }
      if (!snapshot.generation) phase = 'starting';
      const candidate = ++generation;
      generationsOnHost += 1;
      const prepared = (await host.call('prepare', { generation: candidate, plugins: list })).value;
      if (prepared.state !== 'prepared') {
        diagnostics = prepared.diagnostics || [];
        if (!snapshot.generation) phase = 'degraded';
        throw rejection(prepared);
      }
      // 目录类贡献在准备阶段一次性求值并随快照固定；求值失败按候选被拒处理。
      let candidateSnapshot;
      try {
        const draft = buildSnapshot(candidate, list);
        const catalogAliases = await collectCatalogAliases(
          (id, value) => host.call('invoke', { generation: candidate, contributionId: id, value }),
          draft
        );
        candidateSnapshot = buildSnapshot(candidate, list, { catalogAliases });
      } catch (error) {
        try { await host.call('dispose', { generation: candidate }); } catch (_cleanupError) {}
        diagnostics = error.diagnostics || [{ code: error.code || 'plugin_catalog_failed', detail: error.message }];
        if (!snapshot.generation) phase = 'degraded';
        const rejected = new PluginError('plugin_candidate_rejected', error.message);
        rejected.diagnostics = diagnostics;
        throw rejected;
      }
      let committed;
      if (commit) {
        try { committed = await commit(); } catch (error) {
          try { await host.call('dispose', { generation: candidate }); } catch (_cleanupError) {}
          throw error;
        }
      }
      await host.call('activate', { generation: candidate, retainPrevious: true });
      const previous = snapshot.generation;
      snapshot = candidateSnapshot;
      retire(previous);
      diagnostics = [];
      lastError = null;
      consecutiveFailures = 0;
      phase = 'active';
      return { state: 'active', generation: candidate, contributions: prepared.contributions || [], committed };
    });
  }

  function hasContributions(capability) {
    return (snapshot.byCapability.get(capability) || []).length > 0;
  }

  /**
   * 网关请求开始时调用：固定当前代次。没有活跃代次时返回 null（调用方走无插件快路径）。
   * 返回的 release 必须在请求结束时调用一次（多次调用无害）。
   */
  function leaseOn(current) {
    leases.set(current.generation, (leases.get(current.generation) || 0) + 1);
    let released = false;
    const lease = Object.freeze({
      snapshot: current,
      generation: current.generation,
      // 在同一代次上再取一份租约（例如观察事件晚于请求结束才投递）。
      retain: () => leaseOn(current),
      release() {
        if (released) return;
        released = true;
        const remaining = (leases.get(current.generation) || 1) - 1;
        if (remaining > 0) leases.set(current.generation, remaining);
        else leases.delete(current.generation);
        if (remaining <= 0 && retiring.has(current.generation)) disposeGeneration(current.generation, 'drained');
      }
    });
    return lease;
  }

  function acquire() {
    const current = snapshot;
    if (!current.generation) return null;
    return leaseOn(current);
  }

  // 观察（observer）：best-effort、绝不阻塞请求路径。事件进有界队列，后台按快照顺序逐个投递给 observe 贡献项；
  // 队列满时丢弃新事件并计数（规划 §4.3：不积压无界业务正文）。每个排队事件持有自己代次的租约，投递完释放。
  const observation = { queue: [], draining: false, delivered: 0, dropped: 0, failed: 0 };
  const observeQueueLimit = Math.max(1, Number(options.observeQueueLimit || 256));
  const observeTimeoutMs = Math.max(1, Number(options.observeTimeoutMs || 1000));

  async function drainObservations() {
    if (observation.draining) return;
    observation.draining = true;
    try {
      while (observation.queue.length) {
        const { lease, event } = observation.queue.shift();
        for (const item of lease.snapshot.byCapability.get('observe') || []) {
          try {
            await invoke(item.id, event, { generation: lease.generation, timeoutMs: observeTimeoutMs });
            observation.delivered += 1;
          } catch (_error) {
            observation.failed += 1;
          }
        }
        lease.release();
      }
    } finally {
      observation.draining = false;
    }
  }

  function observe(lease, event) {
    if (!lease || !(lease.snapshot.byCapability.get('observe') || []).length) return false;
    if (observation.queue.length >= observeQueueLimit) {
      observation.dropped += 1;
      return false;
    }
    observation.queue.push({ lease: lease.retain(), event });
    setImmediate(() => { void drainObservations(); });
    return true;
  }

  // 插件失败但请求照常继续的情形（delegate、尝试已开始后的 deny）：只计数并保留最近几条，供状态页排查。
  const failures = { total: 0, recent: [] };
  function recordFailure(failure) {
    failures.total += 1;
    failures.recent.push({ ...failure, at: Date.now() });
    if (failures.recent.length > 20) failures.recent.shift();
    log({ event: 'plugin_contribution_failed', ...failure });
  }

  async function invoke(contributionId, value, callOptions = {}) {
    const target = Number(callOptions.generation || snapshot.generation);
    if (!target || !supervisor) throw new PluginError('plugin_runtime_inactive', '当前没有已发布的插件代次');
    return supervisor.call('invoke', { generation: target, contributionId, value }, {
      timeoutMs: callOptions.timeoutMs,
      signal: callOptions.signal,
      // 只处理这一次调用名下的反向调用（gateway.attempt 的 next）。
      onCall: callOptions.onCall
    });
  }

  // 启动恢复：异步执行，不阻塞调用方；没有启用实例时什么也不做。
  function start() {
    stopping = false;
    const plugins = desiredPlugins();
    if (!plugins.length) return Promise.resolve({ state: 'idle' });
    return recover().then(() => status());
  }

  async function stop() {
    if (restartTimer) { timers.clearTimeout(restartTimer); restartTimer = null; }
    await enqueue(async () => { await stopHost(); phase = 'stopped'; });
  }

  function status() {
    return {
      state: phase,
      activeGeneration: snapshot.generation,
      generationsOnHost,
      recycleAfterGenerations,
      contributions: [...snapshot.byCapability.values()].flat().map((item) => item.id).sort(),
      catalogAliases: snapshot.catalogAliases.map((item) => ({ alias: item.alias, target: item.target, instanceId: item.instanceId })),
      leases: Object.fromEntries(leases),
      retiringGenerations: [...retiring.keys()],
      forcedRetirements,
      observations: { queued: observation.queue.length, delivered: observation.delivered, dropped: observation.dropped, failed: observation.failed },
      contributionFailures: { total: failures.total, recent: failures.recent.slice() },
      diagnostics: diagnostics.slice(),
      lastError,
      restarts,
      consecutiveFailures,
      lastExit,
      host: supervisor ? supervisor.status() : { running: false, pid: 0 }
    };
  }

  return { publish, invoke, acquire, observe, recordFailure, hasContributions, snapshot: () => snapshot, start, stop, status };
}

module.exports = { createPluginRuntimeService, buildSnapshot };
