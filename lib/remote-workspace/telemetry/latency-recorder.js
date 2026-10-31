'use strict';

// 延迟与可观测性：滑动窗口记录 RTT（健康探测的纯往返）与每类操作的耗时，给出 p50/p95/最近一次。
// 只存数字，不存路径与命令内容（不让遥测成为泄露通道）。

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

class LatencyRecorder {
  constructor({ window = 200 } = {}) {
    this.window = window;
    this.series = new Map();
  }

  record(kind, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let list = this.series.get(kind);
    if (!list) {
      list = [];
      this.series.set(kind, list);
    }
    list.push(Math.round(ms * 10) / 10);
    if (list.length > this.window) list.shift();
  }

  summary(kind) {
    const list = this.series.get(kind) || [];
    const sorted = [...list].sort((a, b) => a - b);
    return {
      count: list.length,
      last: list.length ? list[list.length - 1] : null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length ? sorted[sorted.length - 1] : null
    };
  }

  snapshot() {
    const out = {};
    for (const kind of this.series.keys()) out[kind] = this.summary(kind);
    return out;
  }
}

module.exports = { LatencyRecorder, percentile };
