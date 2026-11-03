'use strict';

// 连接池（Object Pool）：按「SSH 连接 ID + 车道」复用受管连接。
//
// - 同一台远端的所有工作区、所有请求共享这几条连接（连接可复用，握手只做一次）；
// - 交互车道 / 重活车道分开，重活不堵交互；
// - 空闲 idleCloseMs 未被使用自动关闭，下次请求再惰性重建；
// - 每台远端一个断路器：远端彻底不可用时快速失败，不让请求都去撞连接超时。

const { RemoteConnection } = require('./remote-connection');
const { CircuitBreaker } = require('./circuit-breaker');
const { LatencyRecorder } = require('../telemetry/latency-recorder');
const { isRetryable } = require('../errors');

class ConnectionPool {
  constructor({ connector, config, timers, now } = {}) {
    this.connector = connector;
    this.config = config;
    this.timers = timers || { setTimeout, clearTimeout };
    this.now = now || Date.now;
    this.entries = new Map(); // targetId → { target, lanes: Map<lane, {conn, idleTimer}>, breaker, recorder }
  }

  entryFor(target) {
    let entry = this.entries.get(target.id);
    if (!entry) {
      entry = {
        target,
        lanes: new Map(),
        breaker: new CircuitBreaker({ ...this.config.breaker, now: this.now }),
        recorder: new LatencyRecorder({ window: this.config.telemetry.window })
      };
      this.entries.set(target.id, entry);
    } else {
      entry.target = target; // 连接配置被编辑（换密钥 / 端口）：下次建连用新值
    }
    return entry;
  }

  /** 拿到某车道的受管连接（已在用的直接复用）。 */
  connection(target, lane = 'interactive') {
    const entry = this.entryFor(target);
    let slot = entry.lanes.get(lane);
    if (!slot) {
      const conn = new RemoteConnection({
        connector: this.connector,
        target: entry.target,
        config: this.config,
        recorder: entry.recorder,
        timers: this.timers,
        now: this.now,
        lane
      });
      slot = { conn, idleTimer: null };
      entry.lanes.set(lane, slot);
    }
    this.touch(entry, lane, slot);
    return slot.conn;
  }

  touch(entry, lane, slot) {
    if (slot.idleTimer) this.timers.clearTimeout(slot.idleTimer);
    slot.idleTimer = this.timers.setTimeout(() => {
      slot.conn.close();
      entry.lanes.delete(lane);
    }, this.config.pool.idleCloseMs);
    if (slot.idleTimer && typeof slot.idleTimer.unref === 'function') slot.idleTimer.unref();
  }

  /**
   * 在某车道上执行一个通道操作，经过断路器与延迟记录。
   * @param {string} kind 遥测分类（read / list / exec / ...）
   */
  run(target, { lane = 'interactive', kind, timeoutMs }, fn) {
    return this.guarded(target, kind, () => this.connection(target, lane)
      .withChannel(kind, timeoutMs || this.config.op.defaultTimeoutMs, fn));
  }

  /** 在常驻命令会话里执行一条 POSIX 命令（一个往返），同样经过断路器与延迟记录。 */
  runShell(target, { lane = 'interactive', kind, timeoutMs }, command, options = {}) {
    return this.guarded(target, kind, () => this.connection(target, lane)
      .withShell(command, { ...options, label: kind, timeoutMs: timeoutMs || this.config.op.defaultTimeoutMs }));
  }

  async guarded(target, kind, operation) {
    const entry = this.entryFor(target);
    entry.breaker.enter();
    const startedAt = this.now();
    try {
      const result = await operation();
      entry.breaker.success();
      entry.recorder.record(kind, this.now() - startedAt);
      return result;
    } catch (error) {
      // 只有连接层失败计入熔断；文件不存在之类的业务错误说明远端是好的。
      if (isRetryable(error)) entry.breaker.failure();
      else entry.breaker.success();
      throw error;
    }
  }

  /**
   * 借出某车道健康连接的底层 ssh2 Client（端口转发等不走通道配额的用途，如出网中继）。
   * 断线重连后旧 Client 失效，调用方要在一次任务内用完。
   */
  async rawConnection(target, lane) {
    const entry = this.entryFor(target);
    entry.breaker.enter();
    try {
      const conn = await this.connection(target, lane).ready();
      entry.breaker.success();
      if (!conn.raw) throw require('../errors').remoteError('connection_lost', '连接已断开');
      return conn.raw;
    } catch (error) {
      if (require('../errors').isRetryable(error)) entry.breaker.failure();
      throw error;
    }
  }

  snapshot(targetId) {
    const entry = this.entries.get(targetId);
    if (!entry) return null;
    return {
      breaker: entry.breaker.snapshot(),
      lanes: Object.fromEntries([...entry.lanes].map(([lane, slot]) => [lane, slot.conn.snapshot()])),
      latency: entry.recorder.snapshot()
    };
  }

  /** 关闭某台远端的全部连接（连接被删除 / 指纹重置时）。 */
  drop(targetId) {
    const entry = this.entries.get(targetId);
    if (!entry) return;
    for (const slot of entry.lanes.values()) {
      if (slot.idleTimer) this.timers.clearTimeout(slot.idleTimer);
      slot.conn.close();
    }
    this.entries.delete(targetId);
  }

  closeAll() {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }
}

module.exports = { ConnectionPool };
