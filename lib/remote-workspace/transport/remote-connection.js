'use strict';

// 一条「受管」的远端连接：在 ssh-connector 的原始连接之上，组合健康探测、通道配额、截止时间、
// 断线自动重建（Facade）。上层（remote-ops）只调用 exec / sftp，永远拿到「健康连接上的通道」
// 或一个明确的错误，不用关心重连。
//
// 状态：idle → connecting → ready ⇄ reconnecting → closed
//   - 健康探测判死、或底层 close/error：进入 reconnecting，按退避重建；期间新请求排队等 ready；
//   - 显式 close()：进入 closed，拒绝所有请求，不再重建。

const { EventEmitter } = require('node:events');
const { ChannelLimiter } = require('../channel/channel-limiter');
const { ShellPool } = require('../channel/shell-pool');
const { withDeadline } = require('../channel/deadline');
const { HealthMonitor } = require('./health-monitor');
const { remoteError, fromTransportError } = require('../errors');

class RemoteConnection extends EventEmitter {
  /**
   * @param {{connector, target, config, recorder, timers?, now?, lane?}} options
   *   connector: { connect(target, {readyTimeoutMs, keepalive...}) → Promise<raw> }（Adapter，见 ssh-connector）
   *   target: 已解析的连接目标（host/port/username/认证材料提供者）
   */
  constructor({ connector, target, config, recorder, timers, now, lane = 'interactive' }) {
    super();
    this.connector = connector;
    this.target = target;
    this.config = config;
    this.recorder = recorder;
    this.timers = timers || { setTimeout, clearTimeout };
    this.now = now || Date.now;
    this.lane = lane;
    this.state = 'idle';
    this.raw = null;
    this.limiter = null;
    this.health = null;
    this.shells = null;
    this.readyWaiters = [];
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.generation = 0;
    this.lastError = null;
  }

  /** 确保连接就绪（首次惰性建连；重连中则等待）。 */
  ready() {
    if (this.state === 'ready') return Promise.resolve(this);
    if (this.state === 'closed') return Promise.reject(remoteError('connection_lost', '连接已关闭'));
    const waiter = new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    if (this.state === 'idle') this.establish();
    return waiter;
  }

  async establish() {
    this.state = this.generation === 0 ? 'connecting' : 'reconnecting';
    this.emit('state', this.state);
    const generation = ++this.generation;
    const startedAt = this.now();
    let raw;
    try {
      raw = await this.connector.connect(this.target, this.config.connect);
    } catch (error) {
      if (this.state === 'closed') return;
      this.lastError = fromTransportError(error);
      // 认证失败、指纹不符这类「重试也不会好」的错误：直接让等待者失败，不进入重连循环。
      if (['auth_failed', 'host_key_mismatch', 'host_unresolved'].includes(this.lastError.code)) {
        this.failWaiters(this.lastError);
        this.state = 'idle';
        this.emit('state', 'failed');
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (this.state === 'closed' || generation !== this.generation) {
      raw.end();
      return;
    }
    this.recorder.record('connect', this.now() - startedAt);
    this.raw = raw;
    this.limiter = new ChannelLimiter({
      max: this.config.channel.maxPerConnection,
      acquireTimeoutMs: this.config.channel.acquireTimeoutMs,
      timers: this.timers
    });
    this.shells = new ShellPool({
      raw,
      limiter: this.limiter,
      max: this.config.channel.shellsPerConnection,
      timers: this.timers,
      openTimeoutMs: this.config.connect.readyTimeoutMs
    });
    raw.once('close', () => this.onLost(generation, remoteError('connection_lost', '与远端的连接已断开')));
    raw.on('error', (error) => this.onLost(generation, fromTransportError(error)));
    this.health = new HealthMonitor({
      probe: (timeoutMs) => this.rawProbe(raw, timeoutMs),
      config: this.config.health,
      recorder: this.recorder,
      timers: this.timers,
      now: this.now
    });
    this.health.on('dead', () => this.onLost(generation, remoteError('probe_timeout', '远端无响应（健康探测超时）')));
    this.health.start();
    this.state = 'ready';
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.emit('state', 'ready');
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(this);
  }

  /** 底层连接丢失（close/error/探测判死）：只处理当前代，旧代的迟到事件忽略。 */
  onLost(generation, error) {
    if (generation !== this.generation || this.state === 'closed' || this.state === 'reconnecting') return;
    this.lastError = error;
    this.teardownRaw();
    this.emit('lost', error);
    this.scheduleReconnect();
  }

  teardownRaw() {
    if (this.health) this.health.stop();
    this.health = null;
    if (this.shells) this.shells.close();
    this.shells = null;
    if (this.limiter) this.limiter.close(); // 排队中的请求立即拿到 connection_lost（可重试）
    this.limiter = null;
    const raw = this.raw;
    this.raw = null;
    if (raw) {
      raw.removeAllListeners('close');
      raw.removeAllListeners('error');
      raw.on('error', () => {}); // 已放弃的连接上的迟到错误不能变成未捕获异常
      try { raw.end(); } catch (_error) { /* 已经断了 */ }
    }
  }

  scheduleReconnect() {
    if (this.state === 'closed') return;
    this.state = 'reconnecting';
    this.emit('state', 'reconnecting');
    const delays = this.config.reconnect.backoffMs;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.establish();
    }, delay);
  }

  failWaiters(error) {
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  /** 健康探测：SSH 层一次往返（不开通道、不占配额、远端不起进程），满载时也能探。 */
  rawProbe(raw, timeoutMs) {
    return withDeadline(({ resolve, reject }) => {
      raw.ping((error) => (error ? reject(fromTransportError(error)) : resolve()));
    }, { timeoutMs, label: 'health probe', timers: this.timers });
  }

  /**
   * 在常驻命令会话（POSIX sh）里执行一条命令：一个往返，不开新通道。
   * 仅用于已确认是 POSIX 的远端（由 RemoteHost 决定）。
   */
  async withShell(command, options) {
    await this.ready();
    const shells = this.shells;
    if (!shells) throw remoteError('connection_lost', '连接已断开');
    return shells.run(command, { ...options, timers: this.timers });
  }

  /**
   * 在健康连接上执行一个通道操作。fn(raw) 返回 Promise；配额在 finally 归还。
   * 连接层错误标记为可重试，由 remote-ops 的重试策略决定是否重试。
   */
  async withChannel(label, timeoutMs, fn) {
    await this.ready();
    const limiter = this.limiter;
    const raw = this.raw;
    if (!limiter || !raw) throw remoteError('connection_lost', '连接已断开');
    return limiter.run(() => fn(raw, { timeoutMs, label, timers: this.timers }));
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownRaw();
    this.failWaiters(remoteError('connection_lost', '连接已关闭'));
    this.emit('state', 'closed');
    this.removeAllListeners();
  }

  snapshot() {
    return {
      lane: this.lane,
      state: this.state,
      reconnectAttempt: this.reconnectAttempt,
      channels: this.limiter ? this.limiter.stats() : null,
      shells: this.shells ? this.shells.stats() : null,
      health: this.health ? this.health.snapshot() : null,
      lastError: this.lastError ? this.lastError.code : null
    };
  }
}

module.exports = { RemoteConnection };
