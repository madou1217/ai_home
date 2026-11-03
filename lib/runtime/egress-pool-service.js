'use strict';

// 出口池与账号出口绑定的桥接：把池子解析出的本地端口，变成账号可绑定的出口。
//
// 设计取舍（为什么走账号出口绑定而不是改请求路径）：
//   - 账号出口绑定（`account:egress:<accountRef>`）已经是**唯一**的出口事实来源，网关请求
//     路径（upstream-endpoints-attempt）和 CLI 启动路径（provider-runtime-env）都消费它。
//     出口池接进这条既有链路，不需要在任何请求路径上加分支。
//   - 因此本模块只做两件事：读节点、起池。绑定只记录 `pool` 模式，实际地址在解析时动态读取：
//     server 进程内经进程内单例（egress-pool-registry）；用户自己启动的 `aih <cli>` 进程里
//     单例为空，改读 server 写下的运行文件（egress-pool-state-file，0600，且要求 server 与
//     内核进程都存活），读不到即 fail-closed。CLI 进程**从不**自己起池 —— 池只归 server 所有。
//
// 生命周期：server 启动时只在**已有账号绑定 `pool`** 时拉起（见 server.js）；之后第一次
// 有请求解析到 `pool` 绑定而池未就绪时，由 registry.ensureEgressPoolStarted 惰性拉起。
// 退出由 server 的 runShutdownCleanup 收尾。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { EgressPoolRuntime } = require('./egress-pool-runtime');
const { readProxyPoolNodes } = require('./egress-pool-node-source');
const { EGRESS_POOL_LANE_SLOTS } = require('../cli/config/constants');

// 出口池默认占用的回环端口段（避开 server 9527、Go core 19550 等既有端口）。
const DEFAULT_MIXED_PORT = 17890;
const DEFAULT_CONTROLLER_PORT = 17891;
// 探测入站与车道入站紧随其后：17892 探测，17893.. 车道（EGRESS_POOL_LANE_SLOTS 个）。
const DEFAULT_PROBE_PORT = 17892;
const DEFAULT_LANE_PORT_BASE = 17893;
// 启动失败后的冷却：惰性拉起由请求热路径触发，失败（缺内核/缺节点/端口被占）时
// 不能每个请求都重新读节点、起进程。
const START_RETRY_BACKOFF_MS = 60000;

/**
 * 出口池服务：持有运行时实例，并把就绪的端口暴露给调用方。
 *
 * 与 server 的关系：server 启动时 start()、退出时 stop()。任何失败都只记录，
 * 不影响 server 本身 —— 出口池是增强能力，没它其它 provider 照常工作。
 */
class EgressPoolService {
  constructor(options = {}) {
    this.options = options;
    this.fs = options.fs || nodeFs;
    this.path = options.path || nodePath;
    this.aiHomeDir = String(options.aiHomeDir || '').trim();
    this.env = options.env || process.env || {};
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.enabled = options.enabled !== false;
    this.runtime = null;
    this.lastStartResult = null;
    this.startPromise = null;
    this.lastFailedStartAt = 0;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.startRetryBackoffMs = Number.isFinite(Number(options.startRetryBackoffMs))
      ? Math.max(0, Number(options.startRetryBackoffMs))
      : START_RETRY_BACKOFF_MS;
    // 最近一次车道规划：内核重启（新 runtime）时在启动前先灌进去，就绪即按它选节点。
    this.lanePlan = [];
    this.onReady = typeof options.onReady === 'function' ? options.onReady : null;
    const slots = Number.isInteger(options.laneSlots) && options.laneSlots >= 0 ? options.laneSlots : EGRESS_POOL_LANE_SLOTS;
    const laneBase = Number(options.lanePortBase) || DEFAULT_LANE_PORT_BASE;
    this.lanePorts = Array.from({ length: slots }, (_, index) => laneBase + index);
    this.probePort = options.probePort === 0 ? 0 : (Number(options.probePort) || DEFAULT_PROBE_PORT);
  }

  /** 就绪回调（server 用它在池就绪后立即跑一次车道规划）。 */
  setOnReady(fn) {
    this.onReady = typeof fn === 'function' ? fn : null;
  }

  /** 应用车道规划；池未就绪时只记下，下次启动生效。永不抛。 */
  async applyLanePlan(plan) {
    this.lanePlan = Array.isArray(plan) ? plan : [];
    if (!this.runtime || typeof this.runtime.applyLanePlan !== 'function') return { lanes: [], overflow: [], pending: true };
    try {
      return await this.runtime.applyLanePlan(this.lanePlan);
    } catch (error) {
      return { lanes: [], overflow: [], error: String((error && error.message) || error) };
    }
  }

  /**
   * 惰性拉起：未就绪、未在启动中、且不在失败冷却期内时，后台启动一次。永不抛、不等待。
   * 返回 true 表示本次确实发起了启动。
   */
  ensureStarted() {
    if (!this.enabled || this.ready || this.startPromise) return false;
    if (this.lastFailedStartAt && this.now() - this.lastFailedStartAt < this.startRetryBackoffMs) return false;
    this.start().catch(() => {});
    return true;
  }

  get ready() {
    return Boolean(this.runtime && this.runtime.ready);
  }

  /** 池的本地出站地址；未就绪返回 ''。 */
  get proxyUrl() {
    return this.runtime ? this.runtime.proxyUrl : '';
  }

  /** 最近一次启动失败的原因（成功或从未启动时为 ''）。失败后 runtime 已清空，原因只存在这里。 */
  get lastStartError() {
    const result = this.lastStartResult;
    return result && result.ok === false ? String(result.error || '') : '';
  }

  get status() {
    if (!this.runtime) {
      return {
        enabled: this.enabled,
        ready: false,
        proxyUrl: '',
        nodeCount: 0,
        starting: Boolean(this.startPromise),
        lastError: this.lastStartError
      };
    }
    return { enabled: this.enabled, starting: Boolean(this.startPromise), ...this.runtime.status };
  }

  /**
   * 启动出口池。返回 { ok, proxyUrl, nodeCount } 或 { ok:false, error }。
   * 未启用、无节点、无内核时都安静返回 ok:false —— 调用方不需要区分处理。
   */
  async start() {
    if (!this.enabled) return { ok: false, error: 'egress_pool_disabled' };
    if (this.ready) return { ok: true, proxyUrl: this.proxyUrl, nodeCount: this.runtime.nodeNames.length };
    // 并发启动只起一个内核：后来者等同一次启动的结果。
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce().then((result) => {
      this.lastFailedStartAt = result && result.ok ? 0 : this.now();
      return result;
    }, (error) => {
      this.lastFailedStartAt = this.now();
      throw error;
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startOnce() {

    const source = readProxyPoolNodes({
      fs: this.fs,
      aiHomeDir: this.aiHomeDir,
      env: this.env,
      getProxyNodeStore: this.options.getProxyNodeStore
    });
    if (!source.ok) {
      this.logger(`egress-pool skipped: ${source.error}`);
      this.lastStartResult = { ok: false, error: source.error };
      return this.lastStartResult;
    }

    const runtime = new EgressPoolRuntime({
      aiHomeDir: this.aiHomeDir,
      nodes: source.nodes,
      mixedPort: Number(this.options.mixedPort) || DEFAULT_MIXED_PORT,
      controllerPort: Number(this.options.controllerPort) || DEFAULT_CONTROLLER_PORT,
      fs: this.fs,
      path: this.path,
      env: this.env,
      logger: this.logger,
      spawn: this.options.spawn,
      fetch: this.options.fetch,
      os: this.options.os,
      networkInterfaces: this.options.networkInterfaces,
      startupTimeoutMs: this.options.startupTimeoutMs,
      startupPollIntervalMs: this.options.startupPollIntervalMs,
      switchSettleMs: this.options.switchSettleMs,
      processObj: this.options.processObj,
      isPidAlive: this.options.isPidAlive,
      reapTimeoutMs: this.options.reapTimeoutMs,
      probePort: this.probePort,
      lanePorts: this.lanePorts,
      proxyFetch: this.options.proxyFetch,
      probeIntervalMs: this.options.probeIntervalMs
    });
    this.runtime = runtime;
    if (this.lanePlan.length) await runtime.applyLanePlan(this.lanePlan);

    let result = await runtime.start();
    if (this.runtime !== runtime) {
      // stop() 抢在启动途中：本次实例已不归服务跟踪，必须自己收尾，不能留下一个内核。
      runtime.stop();
      result = { ok: false, error: 'egress_pool_stopped_during_start' };
    }
    this.lastStartResult = result;
    if (!result.ok) {
      // 启动失败不留半死实例：否则 status 会报出一个用不了的 proxyUrl。
      runtime.stop();
      if (this.runtime === runtime) this.runtime = null;
      this.logger(`egress-pool unavailable: ${result.error}`);
      return result;
    }
    if (this.onReady) {
      try { this.onReady(this); } catch (_error) { /* 规划失败不影响池 */ }
    }
    return result;
  }

  /** 停止并清理。幂等。 */
  stop() {
    if (!this.runtime) return;
    try {
      this.runtime.stop();
    } finally {
      this.runtime = null;
    }
  }
}

module.exports = {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_LANE_PORT_BASE,
  DEFAULT_MIXED_PORT,
  DEFAULT_PROBE_PORT,
  EgressPoolService,
  START_RETRY_BACKOFF_MS
};
