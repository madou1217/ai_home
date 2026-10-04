'use strict';

// 服务端独占的 Plugin Host 生命周期：发布代次、崩溃重启、按代数回收宿主进程。
//
// 发布协议（publish）按规划 §5：
//   prepare 候选代次（被拒 → 带诊断失败，旧代次不受影响）
//   → commit 回调（控制面以 expectedRevision 做 CAS；冲突 → 只丢弃候选，旧代次继续服务）
//   → activate（宿主切到新代次并排空、卸载旧代次）
// 所有发布在一个队列里串行执行。
//
// 没有任何启用实例时不启动宿主进程（M0 冻结门槛）。启动时的恢复是异步的，失败只把状态记为
// degraded 并附带诊断，绝不拖累网关启动。宿主意外退出按退避重启并恢复上一次的期望状态，
// 连续失败超过上限停在 degraded，不无限重拉。
// 代次轮换的模块内存不可回收（M0 报告 §4.1）：宿主上累计准备的代数达到阈值时，下一次发布前先重启宿主。

const { PluginError } = require('../sdk/errors');
const { createPluginHostSupervisor } = require('../host/supervisor');

const DEFAULT_BACKOFF_MS = Object.freeze([500, 1000, 2000, 5000, 10000]);

function createPluginRuntimeService(options = {}) {
  const supervisorFactory = options.supervisorFactory || ((supervisorOptions) => createPluginHostSupervisor(supervisorOptions));
  const desiredPlugins = typeof options.desiredPlugins === 'function' ? options.desiredPlugins : () => [];
  const recycleAfterGenerations = Math.max(1, Number(options.recycleAfterGenerations || 32));
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length ? options.backoffMs : DEFAULT_BACKOFF_MS;
  const maxConsecutiveFailures = Math.max(1, Number(options.maxConsecutiveFailures || backoffMs.length));
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timers = options.timers || { setTimeout, clearTimeout };

  let supervisor = null;
  let phase = 'idle';
  let generation = 0;
  let activeGeneration = 0;
  let generationsOnHost = 0;
  let contributions = [];
  let diagnostics = [];
  let lastError = null;
  let restarts = 0;
  let consecutiveFailures = 0;
  let lastExit = null;
  let stopping = false;
  let restartTimer = null;
  let queue = Promise.resolve();

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

  function onHostExit(exit) {
    lastExit = exit;
    activeGeneration = 0;
    generationsOnHost = 0;
    contributions = [];
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
    activeGeneration = 0;
    generationsOnHost = 0;
    contributions = [];
  }

  function rejection(prepared) {
    const error = new PluginError('plugin_candidate_rejected', (prepared.diagnostics || []).map((item) => item.detail || item.code).join('；') || '候选代次被拒绝');
    error.diagnostics = prepared.diagnostics || [];
    return error;
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
        await stopHost();
        phase = 'idle';
        diagnostics = [];
        consecutiveFailures = 0;
        return { state: 'idle', generation: 0 };
      }
      const host = ensureSupervisor();
      if (generationsOnHost >= recycleAfterGenerations) {
        log({ event: 'plugin_host_recycle', generationsOnHost });
        await stopHost();
      }
      phase = activeGeneration ? phase : 'starting';
      const candidate = ++generation;
      generationsOnHost += 1;
      const prepared = (await host.call('prepare', { generation: candidate, plugins: list })).value;
      if (prepared.state !== 'prepared') {
        diagnostics = prepared.diagnostics || [];
        if (!activeGeneration) phase = 'degraded';
        throw rejection(prepared);
      }
      let committed;
      if (commit) {
        try { committed = await commit(); } catch (error) {
          try { await host.call('dispose', { generation: candidate }); } catch (_cleanupError) {}
          throw error;
        }
      }
      await host.call('activate', { generation: candidate });
      activeGeneration = candidate;
      contributions = prepared.contributions || [];
      diagnostics = [];
      lastError = null;
      consecutiveFailures = 0;
      phase = 'active';
      return { state: 'active', generation: candidate, contributions, committed };
    });
  }

  async function invoke(contributionId, value, callOptions = {}) {
    if (!activeGeneration || !supervisor) throw new PluginError('plugin_runtime_inactive', '当前没有已发布的插件代次');
    const response = await supervisor.call('invoke', { generation: activeGeneration, contributionId, value }, callOptions);
    return response;
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
      activeGeneration,
      generationsOnHost,
      recycleAfterGenerations,
      contributions: contributions.slice(),
      diagnostics: diagnostics.slice(),
      lastError,
      restarts,
      consecutiveFailures,
      lastExit,
      host: supervisor ? supervisor.status() : { running: false, pid: 0 }
    };
  }

  return { publish, invoke, start, stop, status };
}

module.exports = { createPluginRuntimeService };
