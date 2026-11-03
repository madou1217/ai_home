'use strict';

// 应用层健康探测（Observer）：不信任 TCP / ssh2 自己报告的「连接正常」。
//
// 每 probeIntervalMs 在连接上做一次真实往返（exec 一条最短命令），同时测 RTT。
// 探测超时阈值随 RTT 基线自适应：max(floor, 基线 × multiplier)；连续 failuresBeforeDead 次失败
// 发出 'dead'，由连接层主动销毁并重建 —— 半开连接（NAT 超时、Wi-Fi 切换、远端挂起）
// 不会让请求永远挂着。

const { EventEmitter } = require('node:events');

class HealthMonitor extends EventEmitter {
  /**
   * @param {{probe: (timeoutMs: number) => Promise<void>, config, recorder?, timers?, now?}} options
   */
  constructor({ probe, config, recorder, timers, now }) {
    super();
    this.probe = probe;
    this.config = config;
    this.recorder = recorder;
    this.timers = timers || { setTimeout, clearTimeout };
    this.now = now || Date.now;
    this.failures = 0;
    this.baselineMs = null;
    this.lastRttMs = null;
    this.timer = null;
    this.running = false;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  probeTimeoutMs() {
    const base = this.baselineMs == null ? 0 : this.baselineMs * this.config.probeTimeoutMultiplier;
    return Math.max(this.config.probeTimeoutFloorMs, Math.round(base));
  }

  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    const startedAt = this.now();
    try {
      await this.probe(this.probeTimeoutMs());
      const rtt = this.now() - startedAt;
      this.lastRttMs = rtt;
      // 基线用指数平滑，单次抖动不会把阈值拉飞。
      this.baselineMs = this.baselineMs == null ? rtt : Math.round(this.baselineMs * 0.8 + rtt * 0.2);
      this.failures = 0;
      if (this.recorder) this.recorder.record('rtt', rtt);
    } catch (_error) {
      this.failures += 1;
      if (this.failures >= this.config.failuresBeforeDead) {
        this.running = false;
        this.stop();
        this.emit('dead');
        return;
      }
    }
    this.running = false;
    this.schedule(this.config.probeIntervalMs);
  }

  snapshot() {
    return { rttMs: this.lastRttMs, baselineMs: this.baselineMs, failures: this.failures };
  }
}

module.exports = { HealthMonitor };
