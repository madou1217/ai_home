'use strict';

/**
 * 默认出口自动切换（看门狗）。
 *
 * 内核运行且分流需要代理时，按固定间隔测当前默认出口；连续 failureThreshold 次不通，
 * 就测速全部节点、换成最快的可用节点，并记录一条切换事件。规则：
 * - 默认关闭，由用户在 WebUI 打开；直连模式、内核未运行、没设默认出口时什么都不做。
 * - 没有可用候选（多半是本机网络整体断了）时不切换，下一轮再试，避免在坏节点间来回跳。
 * - 切换走 service.replaceActiveOutbound(expected, next)：只有默认出口仍是检测时那一个才替换，
 *   用户在检测期间手动改过就放弃本次切换。
 */

const DEFAULT_CONFIG = Object.freeze({ enabled: false, intervalSec: 60, failureThreshold: 3 });
const INTERVAL_RANGE = Object.freeze({ min: 15, max: 3600 });
const THRESHOLD_RANGE = Object.freeze({ min: 1, max: 10 });
const MAX_EVENTS = 20;

function clampInteger(value, range, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(range.max, Math.max(range.min, number));
}

function normalizeFailoverConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled === true,
    intervalSec: clampInteger(source.intervalSec, INTERVAL_RANGE, DEFAULT_CONFIG.intervalSec),
    failureThreshold: clampInteger(source.failureThreshold, THRESHOLD_RANGE, DEFAULT_CONFIG.failureThreshold)
  };
}

/** 校验用户提交的配置：只接受已知字段，越界直接拒绝而不是静默修正。 */
function validateFailoverConfigUpdate(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_outbound_failover_config' };
  const update = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'invalid_outbound_failover_config' };
    update.enabled = input.enabled;
  }
  for (const [key, range] of [['intervalSec', INTERVAL_RANGE], ['failureThreshold', THRESHOLD_RANGE]]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      return { ok: false, error: `invalid_outbound_failover_${key === 'intervalSec' ? 'interval' : 'threshold'}` };
    }
    update[key] = value;
  }
  if (Object.keys(update).length === 0) return { ok: false, error: 'invalid_outbound_failover_config' };
  return { ok: true, update };
}

function normalizeFailoverEvents(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((event) => event && typeof event === 'object' && Number.isFinite(Number(event.at)))
    .slice(-MAX_EVENTS);
}

class OutboundFailoverWatchdog {
  /**
   * @param {object} deps
   * @param {object} deps.service  ProxyPoolService（getCoreStatus / pingNode / suggestOutbound / replaceActiveOutbound）
   * @param {object} deps.store    ProxyNodeStore（getOutboundFailover / setOutboundFailoverConfig / appendOutboundFailoverEvent / getRoutingConfig / getNode）
   */
  constructor(deps = {}) {
    this.service = deps.service;
    this.store = deps.store;
    this.setTimer = deps.setInterval || setInterval;
    this.clearTimer = deps.clearInterval || clearInterval;
    this.now = deps.now || Date.now;
    this.log = deps.log || ((line) => console.log(`\x1b[36m[aih]\x1b[0m ${line}`));
    this.timer = null;
    this.timerIntervalSec = 0;
    this.checking = null;
    this.consecutiveFailures = 0;
    this.lastCheck = null;
  }

  _config() {
    return normalizeFailoverConfig(this.store.getOutboundFailover?.().config);
  }

  /** 按当前配置（重新）排定定时检测；关闭时停止定时器。可重复调用。 */
  start() {
    const config = this._config();
    if (!config.enabled) {
      this.stop();
      return;
    }
    if (this.timer && this.timerIntervalSec === config.intervalSec) return;
    this.stop();
    this.timerIntervalSec = config.intervalSec;
    this.timer = this.setTimer(() => { this.check().catch(() => {}); }, config.intervalSec * 1000);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.timerIntervalSec = 0;
  }

  getStatus() {
    const stored = this.store.getOutboundFailover?.() || {};
    return {
      config: normalizeFailoverConfig(stored.config),
      scheduled: Boolean(this.timer),
      consecutiveFailures: this.consecutiveFailures,
      lastCheck: this.lastCheck,
      events: normalizeFailoverEvents(stored.events).slice().reverse()
    };
  }

  updateConfig(input) {
    const validated = validateFailoverConfigUpdate(input);
    if (!validated.ok) return validated;
    this.store.setOutboundFailoverConfig(validated.update);
    if (validated.update.enabled === false) this.consecutiveFailures = 0;
    this.start();
    return { ok: true, ...this.getStatus() };
  }

  /** 执行一次检测（定时器与「立即检测」共用）；并发调用合并为同一次。 */
  check(options = {}) {
    if (!this.checking) {
      this.checking = this._check(options).finally(() => { this.checking = null; });
    }
    return this.checking;
  }

  _record(result) {
    this.lastCheck = { at: this.now(), ...result };
    return { ok: true, ...this.lastCheck };
  }

  async _check(options) {
    const config = this._config();
    if (!config.enabled && options.force !== true) return this._record({ action: 'skipped', reason: 'disabled' });
    if (!this.service.getCoreStatus().dataPlaneReady) {
      this.consecutiveFailures = 0;
      return this._record({ action: 'skipped', reason: 'core_not_running' });
    }
    const routing = this.store.getRoutingConfig();
    if (routing.mode === 'direct') return this._record({ action: 'skipped', reason: 'direct_mode' });
    const activeId = routing.activeOutboundNodeId || '';
    if (!activeId) return this._record({ action: 'skipped', reason: 'no_active_outbound' });

    const activeNode = this.store.getNode(activeId) || null;
    let reason = 'unreachable';
    if (activeNode) {
      const probe = await this.service.pingNode(activeId);
      if (probe.ok && probe.reachable) {
        this.consecutiveFailures = 0;
        return this._record({ action: 'healthy', nodeId: activeId, latencyMs: probe.latencyMs });
      }
      if (!probe.ok && probe.error === 'proxy_core_unavailable') {
        return this._record({ action: 'skipped', reason: 'core_not_running' });
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures < config.failureThreshold) {
        return this._record({ action: 'degraded', nodeId: activeId, failures: this.consecutiveFailures });
      }
    } else {
      // 默认出口节点已被删除（如订阅同步移除）：不必等待累计失败。
      reason = 'node_missing';
      this.consecutiveFailures = config.failureThreshold;
    }

    const suggestion = await this.service.suggestOutbound({}, { limit: 5 });
    if (!suggestion.ok) return this._record({ action: 'failed', reason: suggestion.error || 'suggest_failed' });
    const candidate = (suggestion.candidates || []).find((item) => item.nodeId !== activeId);
    if (!candidate) {
      return this._record({ action: 'no_candidate', nodeId: activeId, failures: this.consecutiveFailures });
    }
    const switched = await this.service.replaceActiveOutbound(activeId, candidate.nodeId);
    if (!switched.ok) {
      return this._record({ action: 'skipped', reason: switched.error || 'switch_failed' });
    }
    const event = {
      at: this.now(),
      reason,
      failures: this.consecutiveFailures,
      from: { nodeId: activeId, name: activeNode?.name || activeId },
      to: { nodeId: candidate.nodeId, name: candidate.name, latencyMs: candidate.latencyMs },
      applied: switched.applied === true
    };
    this.store.appendOutboundFailoverEvent(event);
    this.consecutiveFailures = 0;
    this.log(`proxy-pool outbound failover: ${event.from.name} -> ${event.to.name} (${candidate.latencyMs}ms, ${reason})`);
    return this._record({ action: 'switched', event });
  }
}

module.exports = {
  DEFAULT_OUTBOUND_FAILOVER_CONFIG: DEFAULT_CONFIG,
  MAX_OUTBOUND_FAILOVER_EVENTS: MAX_EVENTS,
  OutboundFailoverWatchdog,
  normalizeFailoverConfig,
  normalizeFailoverEvents,
  validateFailoverConfigUpdate
};
