'use strict';

const DEFAULT_FRP_RECONCILE_INTERVAL_MS = 60_000;
const MIN_FRP_RECONCILE_INTERVAL_MS = 15_000;
const MAX_FRP_RECONCILE_INTERVAL_MS = 5 * 60_000;

function boundedInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval)) return DEFAULT_FRP_RECONCILE_INTERVAL_MS;
  return Math.max(
    MIN_FRP_RECONCILE_INTERVAL_MS,
    Math.min(MAX_FRP_RECONCILE_INTERVAL_MS, Math.floor(interval))
  );
}

function startFrpConfigReconcileLoop(options = {}, deps = {}) {
  const reconcile = deps.reconcileAihFrpConfig;
  if (typeof reconcile !== 'function') {
    return {
      run: async () => ({ ok: true, skipped: true }),
      stop() {}
    };
  }
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const intervalMs = boundedInterval(options.intervalMs);
  let stopped = false;
  let active = null;

  async function run() {
    if (stopped) return { ok: true, skipped: true };
    if (active) return active;
    active = Promise.resolve()
      .then(() => reconcile({ aiHomeDir: options.aiHomeDir }))
      .catch((error) => {
        if (typeof deps.logWarn === 'function') {
          deps.logWarn(`FRP configuration reconcile skipped: ${String(
            (error && error.code) || (error && error.message) || error
          )}`);
        }
        return {
          ok: false,
          failures: [{ error: String((error && error.code) || 'frp_reconcile_failed') }]
        };
      })
      .finally(() => {
        active = null;
      });
    return active;
  }

  const timer = setIntervalImpl(() => {
    void run();
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  void run();

  return {
    run,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer);
    }
  };
}

module.exports = {
  DEFAULT_FRP_RECONCILE_INTERVAL_MS,
  MAX_FRP_RECONCILE_INTERVAL_MS,
  MIN_FRP_RECONCILE_INTERVAL_MS,
  startFrpConfigReconcileLoop
};
