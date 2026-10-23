'use strict';

// 账号结果时间桶（Node 侧来源）：账号页状态条 /v0/webui/account-outcomes 的第二路数据。
//
// 背景：Go 只在它自己承接请求时写 account_outcomes。一旦请求交还 Node——自定义上游错误
// 协议（account_error_rules）、Go 重启窗口、插件未支持的阶段等——Go 侧计数就完全停摆，
// 账号页状态条看起来"冻结"，而请求其实是 Node 正常服务的。这里把 Node 实际服务的
// 成功/失败也记进同样的时间桶，视图层把两路来源合并，统计不再取决于"谁承接了流量"。
//
// 存储：$AIH_HOME_DIR/app-state.db 的 KV（key=node-account-outcomes），60s 落盘一次，
// 只保留最近 91 天（与 Go 侧 90 天视图窗口对齐）。

const { toFailureKind } = require('./account-outcome-kinds');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 91;
const STORE_KEY = 'node-account-outcomes';
const MAX_ACCOUNTS = 500;
const MAX_OUTCOMES_PER_BUCKET = 32;
const MAX_LABEL_LENGTH = 48;
const FLUSH_INTERVAL_MS = 60 * 1000;

function localDayStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localHourStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
}

/** 结果标签：'success' 或失败类别（policyKind / error / http_<status>），与 Go 侧同一词表风格。 */
function normalizeOutcome(value) {
  const text = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_LABEL_LENGTH);
  if (!text) return 'failed';
  // Node 的 policy kind 归一到 Go FailureKind 闭集，两路来源在同一个桶里同名（见 account-outcome-kinds）。
  return toFailureKind(text);
}

function bucketKey(granularity, startMs) {
  return `${granularity}:${startMs}`;
}

function createNodeAccountOutcomes(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const storeKey = String(options.storeKey || STORE_KEY);
  let readJsonValue = options.readJsonValue;
  let writeJsonValue = options.writeJsonValue;
  if (typeof readJsonValue !== 'function' || typeof writeJsonValue !== 'function') {
    const store = require('./app-state-store');
    if (typeof readJsonValue !== 'function') readJsonValue = store.readJsonValue;
    if (typeof writeJsonValue !== 'function') writeJsonValue = store.writeJsonValue;
  }
  const buckets = new Map();
  let timer = null;

  function accountBuckets(accountRef) {
    if (!buckets.has(accountRef)) {
      if (buckets.size >= MAX_ACCOUNTS) return null;
      buckets.set(accountRef, new Map());
    }
    return buckets.get(accountRef);
  }

  function increment(accountRef, granularity, startMs, outcome) {
    const account = accountBuckets(accountRef);
    if (!account) return;
    const key = bucketKey(granularity, startMs);
    let bucket = account.get(key);
    if (!bucket) {
      bucket = { granularity, startMs, success: 0, failures: new Map() };
      account.set(key, bucket);
    }
    if (outcome === 'success') {
      bucket.success += 1;
      return;
    }
    if (bucket.failures.size >= MAX_OUTCOMES_PER_BUCKET && !bucket.failures.has(outcome)) return;
    bucket.failures.set(outcome, (bucket.failures.get(outcome) || 0) + 1);
  }

  /** 记一次账号结果；accountRef 缺失（无账号可归属）时不计。 */
  function record(input = {}) {
    const accountRef = String(input.accountRef || '').trim();
    if (!accountRef) return false;
    const atMs = Number(input.atMs);
    const at = Number.isFinite(atMs) && atMs > 0 ? atMs : now();
    const outcome = normalizeOutcome(input.outcome);
    increment(accountRef, 'day', localDayStart(at), outcome);
    increment(accountRef, 'hour', localHourStart(at), outcome);
    return true;
  }

  /** 读某粒度的行；形状与 Go 侧 account_outcomes 行一致，供视图层合并。 */
  function list(granularity, fromMs) {
    const target = granularity === 'hour' ? 'hour' : 'day';
    const from = Number(fromMs);
    const rows = [];
    for (const [accountRef, account] of buckets) {
      for (const bucket of account.values()) {
        if (bucket.granularity !== target) continue;
        if (Number.isFinite(from) && bucket.startMs < from) continue;
        if (bucket.success > 0) {
          rows.push({ account_ref: accountRef, bucket_start_ms: bucket.startMs, outcome: 'success', count: bucket.success });
        }
        for (const [outcome, count] of bucket.failures) {
          if (count > 0) rows.push({ account_ref: accountRef, bucket_start_ms: bucket.startMs, outcome, count });
        }
      }
    }
    return rows;
  }

  function prune(atMs) {
    const cutoff = localDayStart(atMs) - (RETENTION_DAYS - 1) * DAY_MS;
    for (const [accountRef, account] of buckets) {
      for (const [key, bucket] of account) {
        if (bucket.startMs < cutoff) account.delete(key);
      }
      if (account.size === 0) buckets.delete(accountRef);
    }
  }

  function toPayload(atMs) {
    prune(atMs);
    const accounts = {};
    for (const [accountRef, account] of buckets) {
      const entries = [];
      for (const bucket of account.values()) {
        entries.push({
          granularity: bucket.granularity,
          startMs: bucket.startMs,
          success: bucket.success,
          failures: Object.fromEntries(bucket.failures)
        });
      }
      if (entries.length > 0) accounts[accountRef] = entries;
    }
    return { version: 1, updatedAt: atMs, accounts };
  }

  function load() {
    buckets.clear();
    let stored = null;
    try {
      stored = readJsonValue(fs, aiHomeDir, storeKey);
    } catch (_error) {
      stored = null;
    }
    const accounts = stored && stored.accounts && typeof stored.accounts === 'object' ? stored.accounts : {};
    for (const [accountRef, entries] of Object.entries(accounts)) {
      if (!Array.isArray(entries)) continue;
      const account = accountBuckets(String(accountRef));
      if (!account) break;
      for (const entry of entries) {
        const granularity = entry && entry.granularity === 'hour' ? 'hour' : 'day';
        const startMs = Number(entry && entry.startMs);
        if (!Number.isFinite(startMs) || startMs <= 0) continue;
        const bucket = {
          granularity,
          startMs,
          success: Math.max(0, Number(entry.success) || 0),
          failures: new Map()
        };
        const failures = entry.failures && typeof entry.failures === 'object' ? entry.failures : {};
        for (const [outcome, count] of Object.entries(failures)) {
          const normalized = normalizeOutcome(outcome);
          bucket.failures.set(normalized, (bucket.failures.get(normalized) || 0) + Math.max(0, Number(count) || 0));
        }
        account.set(bucketKey(granularity, startMs), bucket);
      }
    }
    prune(now());
  }

  function flush() {
    if (!fs || !aiHomeDir) return false;
    try {
      writeJsonValue(fs, aiHomeDir, storeKey, toPayload(now()));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { flush(); }, FLUSH_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  load();

  return {
    record,
    list,
    flush,
    load,
    start,
    stop,
    size: () => buckets.size
  };
}

module.exports = {
  FLUSH_INTERVAL_MS,
  RETENTION_DAYS,
  STORE_KEY,
  createNodeAccountOutcomes,
  localDayStart,
  localHourStart,
  normalizeOutcome
};
