'use strict';

// 每条连接的通道配额（Semaphore）。
//
// sshd 默认 MaxSessions=10，超过后新通道全部失败；泄漏一个通道就永久少一个名额。
// 这里保证：同时打开的通道不超过上限，超出的排队（带等待超时），且每次 acquire 都配对一次
// release —— 用 run(fn) 包住使用过程，release 在 finally 里，异常、超时都不会泄漏。
// leaked() 暴露「已借出未归还」的计数，供 telemetry 与测试断言。

const { remoteError } = require('../errors');

class ChannelLimiter {
  constructor({ max, acquireTimeoutMs, timers } = {}) {
    if (!Number.isInteger(max) || max <= 0) throw new TypeError('max must be a positive integer');
    this.max = max;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.timers = timers || { setTimeout, clearTimeout };
    this.inUse = 0;
    this.waiters = [];
    this.closed = false;
  }

  acquire() {
    if (this.closed) return Promise.reject(remoteError('connection_lost', '连接已关闭'));
    if (this.inUse < this.max) {
      this.inUse += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = this.timers.setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(remoteError('channel_open_failed', `等待通道超时（上限 ${this.max}）`));
      }, this.acquireTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  releaser() {
    let released = false;
    return () => {
      if (released) return; // 重复 release 不能把配额算多
      released = true;
      const next = this.waiters.shift();
      if (next) {
        this.timers.clearTimeout(next.timer);
        next.resolve(this.releaser()); // 名额直接转交，inUse 不变
        return;
      }
      this.inUse -= 1;
    };
  }

  /** 借一个名额执行 fn，结束（含异常）后必定归还。 */
  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 连接断开：拒绝所有排队者，之后的 acquire 立即失败。 */
  close() {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(remoteError('connection_lost', '连接已关闭'));
    }
  }

  stats() {
    return { inUse: this.inUse, waiting: this.waiters.length, max: this.max };
  }
}

module.exports = { ChannelLimiter };
