'use strict';

// Stale-while-revalidate cache for read-only usage aggregates.
//
// The aggregates scan the whole usage table (100ms~10s) and, when no worker executor
// is configured, run synchronously on the main thread. The gateway writes usage on
// nearly every proxied request, so "drop the cache on write" almost never hits. Here a
// write only marks entries stale:
//   - fresh (younger than ttlMs and not invalidated): returned as-is;
//   - stale but younger than maxStaleMs: returned as-is, one background recompute
//     (at most one per minRefreshIntervalMs per key);
//   - missing / too old: computed for the caller.
// Refresh is driven by reads, never by writes: on a busy gateway the queries may run on
// the main thread, and recomputing every key per write would block the event loop.
// A polling page therefore sees new usage one poll later.

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createModelUsageResultCache(options = {}) {
  const ttlMs = positiveInteger(options.ttlMs, 5000);
  const maxStaleMs = positiveInteger(options.maxStaleMs, 10 * 60 * 1000);
  const minRefreshIntervalMs = positiveInteger(options.minRefreshIntervalMs, 1000);
  const limit = positiveInteger(options.limit, 128);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const entries = new Map();

  function evictIfFull() {
    if (entries.size < limit) return;
    let oldestKey = null;
    let oldestReadAt = Infinity;
    for (const [key, entry] of entries) {
      if (entry.readAt < oldestReadAt) {
        oldestReadAt = entry.readAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
  }

  function compute(key, load) {
    const existing = entries.get(key);
    if (existing && existing.pending) return existing.pending;
    const startedAt = now();
    const pending = Promise.resolve().then(load).then((value) => {
      const current = entries.get(key);
      // A write that landed while computing keeps the entry stale for the next refresh.
      const invalidated = Boolean(current && current.invalidatedAt > startedAt);
      if (!current) evictIfFull();
      entries.set(key, {
        value,
        hasValue: true,
        at: startedAt,
        readAt: current ? current.readAt : now(),
        invalidated,
        invalidatedAt: current ? current.invalidatedAt : 0,
        pending: null,
        load
      });
      return value;
    }, (error) => {
      const current = entries.get(key);
      if (current) {
        current.pending = null;
        if (!current.hasValue) entries.delete(key);
      }
      throw error;
    });
    if (existing) {
      existing.pending = pending;
      existing.load = load;
    } else {
      evictIfFull();
      entries.set(key, {
        value: undefined,
        hasValue: false,
        at: 0,
        readAt: now(),
        invalidated: false,
        invalidatedAt: 0,
        pending,
        load
      });
    }
    return pending;
  }

  function get(key, load) {
    const entry = entries.get(key);
    const current = now();
    if (entry && entry.hasValue && current - entry.at < maxStaleMs) {
      entry.readAt = current;
      const age = current - entry.at;
      if ((entry.invalidated || age >= ttlMs) && age >= minRefreshIntervalMs && !entry.pending) {
        compute(key, load).catch(() => {});
      }
      return Promise.resolve(entry.value);
    }
    if (entry) entry.readAt = current;
    return compute(key, load);
  }

  function invalidate() {
    const at = now();
    for (const [key, entry] of entries) {
      if (at - entry.readAt >= maxStaleMs && !entry.pending) {
        entries.delete(key);
        continue;
      }
      entry.invalidated = true;
      entry.invalidatedAt = at;
    }
  }

  function clear() {
    entries.clear();
  }

  return Object.freeze({ get, invalidate, clear });
}

module.exports = { createModelUsageResultCache };
