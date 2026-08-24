'use strict';

// 运行中的 ZCode 分组出口健康监测器。
//
// 它只探测账号固定的回环 mixed endpoint；连续失败达到阈值后，把“当前节点已失败”
// 这一事实交回出口服务重新调度。监测器不知道节点协议、绑定存储或 sing-box 配置，
// 因而不会形成第二套调度/数据面实现。

const DEFAULT_HEALTH_INTERVAL_MS = 30 * 1000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

class ZcodeEgressHealthMonitor {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.probeProxyServer = options.probeProxyServer;
    this.recoverAccount = options.recoverAccount;
    this.isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
    this.setInterval = options.setInterval || global.setInterval;
    this.clearInterval = options.clearInterval || global.clearInterval;
    this.now = options.now || Date.now;
    this.intervalMs = positiveInteger(
      options.intervalMs || env.AIH_ZCODE_EGRESS_HEALTH_INTERVAL_MS,
      DEFAULT_HEALTH_INTERVAL_MS,
      1000
    );
    this.failureThreshold = positiveInteger(
      options.failureThreshold || env.AIH_ZCODE_EGRESS_HEALTH_FAILURE_THRESHOLD,
      DEFAULT_HEALTH_FAILURE_THRESHOLD
    );
    this.entries = new Map();
    this.timer = null;
  }

  _ensureTimer() {
    if (this.timer || this.entries.size === 0) return;
    this.timer = this.setInterval(() => {
      void this.checkAll();
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  _stopTimerIfIdle() {
    if (!this.timer || this.entries.size > 0) return;
    this.clearInterval(this.timer);
    this.timer = null;
  }

  track(input = {}) {
    const accountRef = String(input.accountRef || '').trim();
    const proxyServer = String(input.proxyServer || '').trim();
    const selectedNodeId = String(input.selectedNodeId || '').trim();
    const groupId = String(input.groupId || '').trim();
    const pid = Number(input.pid);
    if (!accountRef || !proxyServer || !selectedNodeId || !groupId) {
      if (accountRef) this.untrack(accountRef);
      return null;
    }
    const previous = this.entries.get(accountRef);
    const nodeChanged = previous && previous.selectedNodeId !== selectedNodeId;
    const entry = {
      accountRef,
      proxyServer,
      selectedNodeId,
      groupId,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      recoveryInput: input.recoveryInput,
      consecutiveFailures: nodeChanged ? 0 : Number(previous?.consecutiveFailures || 0),
      lastCheckedAt: Number(previous?.lastCheckedAt || 0),
      lastHealthyAt: Number(previous?.lastHealthyAt || 0),
      lastSwitchAt: nodeChanged ? Number(this.now()) : Number(previous?.lastSwitchAt || 0),
      lastError: nodeChanged ? '' : String(previous?.lastError || ''),
      inFlight: false
    };
    this.entries.set(accountRef, entry);
    this._ensureTimer();
    return this.getStatus(accountRef);
  }

  untrack(accountRef) {
    const normalizedRef = String(accountRef || '').trim();
    if (!normalizedRef) return false;
    const removed = this.entries.delete(normalizedRef);
    this._stopTimerIfIdle();
    return removed;
  }

  getStatus(accountRef) {
    const entry = this.entries.get(String(accountRef || '').trim());
    if (!entry) return { monitoring: false };
    return {
      monitoring: true,
      accountRef: entry.accountRef,
      proxyServer: entry.proxyServer,
      selectedNodeId: entry.selectedNodeId || null,
      groupId: entry.groupId || null,
      pid: entry.pid,
      intervalMs: this.intervalMs,
      failureThreshold: this.failureThreshold,
      consecutiveFailures: entry.consecutiveFailures,
      lastCheckedAt: entry.lastCheckedAt || null,
      lastHealthyAt: entry.lastHealthyAt || null,
      lastSwitchAt: entry.lastSwitchAt || null,
      lastError: entry.lastError || null,
      checking: entry.inFlight
    };
  }

  async _check(entry) {
    if (!entry || entry.inFlight) return this.getStatus(entry?.accountRef);
    if (entry.pid && !this.isProcessAlive(entry.pid)) {
      this.untrack(entry.accountRef);
      return { monitoring: false, inactive: true };
    }
    if (typeof this.probeProxyServer !== 'function') {
      entry.lastError = 'proxy_probe_unavailable';
      return this.getStatus(entry.accountRef);
    }

    entry.inFlight = true;
    entry.lastCheckedAt = Number(this.now());
    const finish = () => {
      entry.inFlight = false;
      return this.getStatus(entry.accountRef);
    };
    try {
      let probe;
      try {
        probe = await this.probeProxyServer(entry.proxyServer);
      } catch (error) {
        probe = { ok: false, reason: String(error?.message || error || 'proxy_probe_failed') };
      }
      if (probe?.ok) {
        entry.consecutiveFailures = 0;
        entry.lastHealthyAt = Number(this.now());
        entry.lastError = '';
        return finish();
      }

      entry.consecutiveFailures += 1;
      entry.lastError = String(probe?.reason || probe?.error || 'proxy_probe_failed');
      if (
        entry.consecutiveFailures < this.failureThreshold
        || typeof this.recoverAccount !== 'function'
      ) return finish();

      const failedNodeId = String(entry.selectedNodeId || '').trim();
      let recovered;
      try {
        recovered = await this.recoverAccount({
          accountRef: entry.accountRef,
          failedNodeIds: failedNodeId ? [failedNodeId] : [],
          recoveryInput: entry.recoveryInput
        });
      } catch (error) {
        recovered = { ok: false, error: String(error?.message || error || 'egress_recovery_failed') };
      }
      if (recovered?.ok && recovered?.applied !== false && recovered.selectedNodeId) {
        const switched = recovered.selectedNodeId !== failedNodeId;
        entry.proxyServer = String(recovered.proxyServer || entry.proxyServer);
        entry.selectedNodeId = String(recovered.selectedNodeId);
        entry.groupId = String(recovered.groupId || entry.groupId);
        entry.consecutiveFailures = 0;
        entry.lastHealthyAt = Number(this.now());
        entry.lastError = '';
        if (switched) entry.lastSwitchAt = Number(this.now());
        const pid = Number(recovered.pid);
        if (Number.isInteger(pid) && pid > 0) entry.pid = pid;
      } else {
        // 本轮已经验证了所有候选仍不可用。下轮不永久排除旧节点，让已经恢复的旧节点
        // 也能重新进入候选；数据面仍由出口服务保持 fail-closed。
        entry.selectedNodeId = '';
        entry.consecutiveFailures = 0;
        entry.lastError = String(recovered?.reason || recovered?.error || 'egress_recovery_failed');
      }
      return finish();
    } finally {
      entry.inFlight = false;
    }
  }

  checkNow(accountRef) {
    const entry = this.entries.get(String(accountRef || '').trim());
    return entry ? this._check(entry) : Promise.resolve({ monitoring: false });
  }

  async checkAll() {
    const results = [];
    for (const entry of [...this.entries.values()]) {
      results.push(await this._check(entry));
    }
    return results;
  }

  stop() {
    this.entries.clear();
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  DEFAULT_HEALTH_FAILURE_THRESHOLD,
  DEFAULT_HEALTH_INTERVAL_MS,
  ZcodeEgressHealthMonitor
};
