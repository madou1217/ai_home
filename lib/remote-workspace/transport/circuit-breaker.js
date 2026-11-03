'use strict';

// 断路器（State 模式：closed → open → half_open → closed）。
//
// 远端彻底不可用时（宕机、sshd 挂了、认证被撤销），不让每个请求都去撞一次 10 秒的连接超时：
// 连续失败达到阈值就熔断，熔断期内立即返回 remote_unavailable；冷却到期后只放一个探测请求
// （half_open），成功即恢复，失败则加倍冷却（上限 maxOpenMs）。

const { remoteError } = require('../errors');

class CircuitBreaker {
  constructor({ failureThreshold, openMs, maxOpenMs, now } = {}) {
    this.failureThreshold = failureThreshold;
    this.baseOpenMs = openMs;
    this.maxOpenMs = maxOpenMs;
    this.now = now || Date.now;
    this.state = 'closed';
    this.failures = 0;
    this.openUntil = 0;
    this.currentOpenMs = openMs;
    this.probing = false;
  }

  /** 请求前调用：熔断中直接抛 remote_unavailable；half_open 只放行一个探测。 */
  enter() {
    if (this.state === 'open') {
      if (this.now() < this.openUntil) {
        throw remoteError('remote_unavailable', '远端暂时不可用，稍后自动重试', { retryInMs: this.openUntil - this.now() });
      }
      this.state = 'half_open';
      this.probing = false;
    }
    if (this.state === 'half_open') {
      if (this.probing) throw remoteError('remote_unavailable', '远端恢复探测中');
      this.probing = true;
    }
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
    this.probing = false;
    this.currentOpenMs = this.baseOpenMs;
  }

  failure() {
    if (this.state === 'half_open') {
      this.trip(Math.min(this.maxOpenMs, this.currentOpenMs * 2));
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip(this.currentOpenMs);
  }

  trip(openMs) {
    this.state = 'open';
    this.probing = false;
    this.currentOpenMs = openMs;
    this.openUntil = this.now() + openMs;
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      ...(this.state === 'open' ? { retryInMs: Math.max(0, this.openUntil - this.now()) } : {})
    };
  }
}

module.exports = { CircuitBreaker };
