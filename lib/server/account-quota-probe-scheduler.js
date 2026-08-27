'use strict';

const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000; // Check every 1 minute
const PROBE_BATCH_SIZE = 4; // Check up to 4 accounts per tick
const PROBE_AHEAD_WINDOW_MS = 3 * 60 * 1000; // If reset is within 3 minutes or past due, auto-probe

function createAccountQuotaProbeScheduler(deps = {}, options = {}) {
  const {
    fs,
    aiHomeDir,
    ensureUsageSnapshotAsync,
    listAccounts,
    readUsageCache
  } = deps;

  const intervalMs = Math.max(10_000, Number(options.quotaProbeIntervalMs) || DEFAULT_SCHEDULER_INTERVAL_MS);
  let timer = null;
  let running = false;
  let inFlight = false;
  const lastProbeMap = new Map();

  async function tick() {
    if (inFlight) return;
    if (typeof ensureUsageSnapshotAsync !== 'function') return;

    inFlight = true;
    try {
      const accountsList = typeof listAccounts === 'function' ? listAccounts() : [];
      const oauthAccounts = (Array.isArray(accountsList) ? accountsList : []).filter((acc) => (
        acc && !acc.apiKeyMode && ['codex', 'claude', 'kimi', 'zcode', 'agy', 'gemini'].includes(String(acc.provider || '').toLowerCase())
      ));

      const now = Date.now();
      const candidates = [];

      for (const account of oauthAccounts) {
        const provider = String(account.provider || '').toLowerCase();
        const accountRef = String(account.accountRef || '').trim();
        if (!accountRef) continue;

        const lastProbedAt = lastProbeMap.get(accountRef) || 0;
        // Don't hammer the same account within 45s
        if (now - lastProbedAt < 45_000) continue;

        let snapshot = account.usageSnapshot;
        if (!snapshot && typeof readUsageCache === 'function') {
          snapshot = readUsageCache(provider, accountRef);
        }

        if (!snapshot) {
          // Cold account without snapshot: lowest priority candidate
          candidates.push({ account, urgency: 1 });
          continue;
        }

        const entries = Array.isArray(snapshot.entries) ? snapshot.entries : (Array.isArray(snapshot.models) ? snapshot.models : []);
        let needsProbe = false;
        let urgency = 0;

        for (const entry of entries) {
          const resetAtMs = Number(entry.resetAtMs) || 0;
          const remainingPct = typeof entry.remainingPct === 'number' ? entry.remainingPct : 100;

          // If consumed/exhausted and near reset time or past due
          if (remainingPct <= 95.0 && resetAtMs > 0) {
            if (now >= resetAtMs - PROBE_AHEAD_WINDOW_MS) {
              needsProbe = true;
              urgency = Math.max(urgency, 10);
            }
          }
        }

        // Periodic background probe if snapshot is older than 15 minutes and quota was consumed
        const capturedAt = Number(snapshot.capturedAt) || 0;
        if (!needsProbe && (now - capturedAt > 15 * 60 * 1000)) {
          const hasConsumption = entries.some(e => typeof e.remainingPct === 'number' && e.remainingPct < 100);
          if (hasConsumption) {
            needsProbe = true;
            urgency = Math.max(urgency, 2);
          }
        }

        if (needsProbe) {
          candidates.push({ account, urgency });
        }
      }

      // Sort by urgency descending
      candidates.sort((a, b) => b.urgency - a.urgency);
      const batch = candidates.slice(0, PROBE_BATCH_SIZE);

      for (const item of batch) {
        const provider = item.account.provider;
        const accountRef = item.account.accountRef;
        lastProbeMap.set(accountRef, now);
        try {
          await ensureUsageSnapshotAsync(provider, accountRef, item.account.usageSnapshot, {
            forceRefresh: true
          });
        } catch (_probeErr) {
          // best-effort probe
        }
      }
    } catch (_tickErr) {
      // ignore
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    setTimeout(() => {
      void tick();
    }, 5000).unref?.();
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick
  };
}

module.exports = {
  createAccountQuotaProbeScheduler,
  __private: {
    PROBE_AHEAD_WINDOW_MS,
    DEFAULT_SCHEDULER_INTERVAL_MS
  }
};
