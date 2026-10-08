'use strict';

const { isAccountRef } = require('../account/public-account-ref');
const { listAccountRefRecords } = require('../server/account-ref-store');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');

const caches = new WeakMap();
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

function readZcodeNativeUsageOwnership({ fs, path, aiHomeDir, store, readJsonlFromOffset }) {
  let cache = caches.get(store);
  if (!cache) { cache = new Map(); caches.set(store, cache); }
  const seen = new Set();
  for (const account of listAccountRefRecords(fs, aiHomeDir, 'zcode')) {
    const accountRef = account.accountRef;
    if (!isAccountRef(accountRef)) continue;
    const profile = resolveAccountRuntimeDir(aiHomeDir, 'zcode', accountRef);
    const logPath = path.join(profile, '.aih-runtime', 'zcode-model-usage-owners.jsonl');
    try {
      // A canonical private profile must not borrow another account's index.
      const expected = path.join(fs.realpathSync(aiHomeDir), path.relative(aiHomeDir, logPath));
      const physical = fs.realpathSync(logPath);
      if (physical !== expected || !fs.lstatSync(logPath).isFile()) continue;
      seen.add(logPath);
      const stat = fs.statSync(logPath);
      const old = cache.get(logPath);
      const sameFile = old && old.stat.ino === stat.ino && old.stat.dev === stat.dev;
      if (sameFile && old.stat.size === stat.size && old.stat.mtimeMs === stat.mtimeMs && old.stat.ctimeMs === stat.ctimeMs) continue;
      const append = sameFile && stat.size > old.stat.size;
      const entries = append ? new Map(old.entries) : new Map();
      const pending = [];
      const read = readJsonlFromOffset(fs, logPath, append ? old.offset : 0, (line, offset) => {
        let record;
        try { record = JSON.parse(line); } catch (_) { return; }
        if (record?.version !== 1 || record.accountRef !== accountRef
          || typeof record.usageId !== 'string' || typeof record.sessionId !== 'string'
          || !ID.test(record.usageId) || !ID.test(record.sessionId)
          || !Number.isSafeInteger(record.startedAtMs) || record.startedAtMs <= 0
          || !Number.isSafeInteger(record.timestampMs) || record.timestampMs < record.startedAtMs) return;
        pending.push({ ...record, offset });
      });
      for (const entry of pending) {
        if (read.hadTrailingLine && entry.offset >= read.trailingLineStart) continue;
        entries.set(`${entry.usageId}:${entry.sessionId}:${entry.startedAtMs}:${entry.timestampMs}`, entry);
      }
      cache.set(logPath, { stat, entries, offset: read.hadTrailingLine ? read.trailingLineStart : read.offset });
    } catch (_) { cache.delete(logPath); }
  }
  for (const logPath of cache.keys()) if (!seen.has(logPath)) cache.delete(logPath);
  const byUsage = new Map();
  for (const file of cache.values()) for (const entry of file.entries.values()) {
    const key = `${entry.usageId}:${entry.sessionId}:${entry.timestampMs}`;
    const matches = byUsage.get(key) || new Map();
    matches.set(entry.accountRef, entry);
    byUsage.set(key, matches);
  }
  const records = [...byUsage.values()].filter((matches) => matches.size === 1).map((matches) => matches.values().next().value);
  function resolve({ usageId, sessionId, startedAtMs, timestampMs }) {
    const matches = byUsage.get(`${usageId}:${sessionId}:${timestampMs}`);
    if (!matches) return null;
    if (matches.size !== 1) return '';
    const entry = matches.values().next().value;
    return entry.startedAtMs === startedAtMs ? entry.accountRef : '';
  }
  return { records, resolve };
}

module.exports = { readZcodeNativeUsageOwnership };
