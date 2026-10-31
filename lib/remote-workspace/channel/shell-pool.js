'use strict';

// 常驻命令会话池（Object Pool）：一条 SSH 连接上最多 max 个 ShellSession，空闲复用、忙时新开、
// 满了排队。每个会话占用连接的一个通道配额（ChannelLimiter），直到作废才归还——
// 保证「会话 + 一次性 exec / sftp」加起来不超过 sshd 的 MaxSessions。
//
// 会话出错 / 超时即作废丢弃，不放回池里；下次按需新开（新开只多一个往返）。

const { ShellSession } = require('./shell-session');
const { remoteError } = require('../errors');

class ShellPool {
  /**
   * @param {{raw, limiter, max, timers?, openTimeoutMs}} options
   */
  constructor({ raw, limiter, max, timers, openTimeoutMs }) {
    this.raw = raw;
    this.limiter = limiter;
    this.max = max;
    this.timers = timers || { setTimeout, clearTimeout };
    this.openTimeoutMs = openTimeoutMs;
    this.idle = [];
    this.count = 0;
    this.waiters = [];
    this.closed = false;
  }

  async acquire() {
    if (this.closed) throw remoteError('connection_lost', '连接已断开');
    while (this.idle.length) {
      const session = this.idle.pop();
      if (!session.dead) return session;
      this.retire(session); // 空闲时被远端关掉的会话：归还名额
    }
    if (this.count < this.max) return this.open();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async open() {
    this.count += 1;
    let releaseSlot = null;
    try {
      releaseSlot = await this.limiter.acquire();
      const session = new ShellSession({ raw: this.raw, timers: this.timers });
      await session.open({ timeoutMs: this.openTimeoutMs });
      session.releaseSlot = releaseSlot;
      return session;
    } catch (error) {
      this.count -= 1;
      if (releaseSlot) releaseSlot();
      this.wakeOne();
      throw error;
    }
  }

  release(session) {
    if (session.dead || this.closed) {
      this.retire(session);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(session);
    else this.idle.push(session);
  }

  retire(session) {
    session.destroy();
    if (session.releaseSlot) { session.releaseSlot(); session.releaseSlot = null; }
    this.count -= 1;
    this.wakeOne();
  }

  // 有会话作废腾出名额：让一个排队者去新开。
  wakeOne() {
    if (this.closed || !this.waiters.length || this.count >= this.max) return;
    const waiter = this.waiters.shift();
    this.open().then(waiter.resolve, waiter.reject);
  }

  /** 借一个会话跑一条命令，跑完归还（出错的会话自动作废）。 */
  async run(command, options) {
    const session = await this.acquire();
    try {
      return await session.run(command, options);
    } finally {
      this.release(session);
    }
  }

  close() {
    this.closed = true;
    for (const session of this.idle.splice(0)) this.retire(session);
    for (const waiter of this.waiters.splice(0)) waiter.reject(remoteError('connection_lost', '连接已断开'));
  }

  stats() {
    return { sessions: this.count, idle: this.idle.length, waiting: this.waiters.length, max: this.max };
  }
}

module.exports = { ShellPool };
