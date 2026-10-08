'use strict';

const { refreshAccountTokenUsage } = require('./model-usage-refresh');

const REFRESH_DELAYS_MS = Object.freeze([250, 1000, 3000]);
const TERMINAL_SESSION_EVENTS = new Set(['session:turn-completed', 'session:turn-failed', 'session:closed']);

function isTerminalSessionEvent(event) {
  return TERMINAL_SESSION_EVENTS.has(event.type) || ['turn-completed', 'turn-failed'].includes(event.phase);
}

// One refresh state machine for providers whose native bill may arrive after
// their completion notification. Provider adapters own identity and scanning.
function createSessionUsageRefresh(options) {
  const bus = options.sessionEventBus;
  const service = options.modelUsageService;
  const setTimer = options.setTimeoutFn || setTimeout;
  const clearTimer = options.clearTimeoutFn || clearTimeout;
  const logWarn = options.logWarn || (() => {});
  const pending = new Map();
  let running = false;

  function arm(entry) {
    entry.timer = setTimer(() => run(entry), REFRESH_DELAYS_MS[entry.attempt]);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  async function run(entry) {
    entry.timer = null;
    const revision = entry.revision;
    let finished = false;
    try {
      const result = await options.scan(entry);
      if (!running || pending.get(entry.key) !== entry) return;
      entry.refreshRequired = entry.refreshRequired || Number(result.records) > 0;
      finished = entry.refreshRequired || entry.attempt === REFRESH_DELAYS_MS.length - 1;
      if (finished && typeof options.onTokenUsageUpdated === 'function') {
        const queriedAt = Date.now();
        for (const provider of entry.usageProviders || [entry.provider]) {
          if (!running || pending.get(entry.key) !== entry) return;
          await refreshAccountTokenUsage(service, (usage, cacheOptions) => {
            if (running && pending.get(entry.key) === entry) return options.onTokenUsageUpdated(usage, cacheOptions);
          }, { provider, nowMs: queriedAt, generatedAt: queriedAt });
        }
      }
    } catch (error) {
      finished = false;
      logWarn(`${options.label || 'Native'} session usage refresh failed: ${String(error && error.message || error)}`);
    }
    if (!running || pending.get(entry.key) !== entry) return;
    if (revision !== entry.revision) {
      entry.attempt = 0;
      if (finished) entry.refreshRequired = false;
    } else if (finished || entry.attempt === REFRESH_DELAYS_MS.length - 1) {
      pending.delete(entry.key);
      return;
    } else {
      entry.attempt += 1;
    }
    arm(entry);
  }

  function notify(event = {}) {
    if (!running) return;
    const session = options.resolveSession(event);
    if (!session) return;
    const key = `${session.provider}:${session.sessionId}`;
    const existing = pending.get(key);
    if (existing) { existing.revision += 1; return; }
    const entry = { ...session, key, revision: 0, attempt: 0, refreshRequired: false, timer: null };
    pending.set(key, entry);
    arm(entry);
  }

  function start() {
    if (running || options.enabled === false || !service || typeof options.scan !== 'function') return;
    running = true;
    if (bus && typeof bus.on === 'function') bus.on('session', notify);
  }

  function stop() {
    running = false;
    if (bus && typeof bus.off === 'function') bus.off('session', notify);
    for (const entry of pending.values()) if (entry.timer !== null) clearTimer(entry.timer);
    pending.clear();
  }

  return { start, stop, notify };
}

module.exports = { createSessionUsageRefresh, isTerminalSessionEvent };
