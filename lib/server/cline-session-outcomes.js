'use strict';

// cline 会话级结果 → 账号结果桶（健康统计的第三个来源）。
//
// 为什么需要：健康统计原本只有「上游 attempt 结果」一种证据。只用原生 CLI 驱动的账号
// （`aih cline <id>`，不经过网关）没有任何 attempt，状态条因此永远是空的。cline 自己
// 会把会话终态写进会话记录（`sessions/<id>/<id>.json` 的 `status` / `exit_code` /
// `ended_at`，2026-10-15 实测 3.0.71），这是该账号可观测的、非猜测的结果证据。
//
// 口径（与 Go FailureKind 闭集对齐，绝不发明新分类）：
//   * status=completed/success/…  → success
//   * status=failed/error         → unclassified（闭集里的「其他」）
//   * status=cancelled/取消 / running / 未知 → 不记（没有账号健康证据）
// 归属复用共享会话库的注册表作用域（lib/usage/cline-usage-ownership.js）：未归属的会话
// 一律不写结果桶，宁可少记也不张冠李戴。
//
// 幂等：每个 (sessionId, status, ended_at) 只记一次，游标持久化在 app-state KV。

const nodePath = require('node:path');
const { readJsonValue, writeJsonValue } = require('./app-state-store');
const { createClineUsageOwnership } = require('../usage/cline-usage-ownership');
const { discoverClineUsageFiles } = require('../usage/model-usage-scanner');

const STORE_KEY = 'cline-session-outcomes';
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
// 游标上限：超出后按插入顺序丢最旧的条目（会话记录本身也有清理）。
const MAX_TRACKED_SESSIONS = 4000;

const SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'ok', 'done']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 会话记录的终态 → 结果标签；'' 表示不记。纯函数，便于单测与复用。 */
function classifyClineSessionOutcome(record = {}) {
  const status = normalizeText(record && record.status).toLowerCase();
  if (!status) return '';
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (FAILURE_STATUSES.has(status)) return 'unclassified';
  return '';
}

function createClineSessionOutcomePoller(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || nodePath;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const hostHomeDir = normalizeText(options.hostHomeDir);
  const nodeAccountOutcomes = options.nodeAccountOutcomes || null;
  const intervalMs = Math.max(30_000, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const storeKey = normalizeText(options.storeKey) || STORE_KEY;

  let timer = null;
  let cursor = null;

  function readCursor() {
    if (cursor) return cursor;
    const raw = readJsonValue(fsImpl, aiHomeDir, storeKey);
    cursor = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    return cursor;
  }

  function persistCursor() {
    const entries = Object.entries(cursor);
    if (entries.length > MAX_TRACKED_SESSIONS) {
      cursor = Object.fromEntries(entries.slice(entries.length - MAX_TRACKED_SESSIONS));
    }
    writeJsonValue(fsImpl, aiHomeDir, storeKey, cursor);
  }

  function tick() {
    const summary = { scanned: 0, recorded: 0, unattributed: 0, skipped: 0 };
    if (!aiHomeDir || !hostHomeDir || !nodeAccountOutcomes
      || typeof nodeAccountOutcomes.record !== 'function') {
      return summary;
    }
    const ownership = createClineUsageOwnership({ fs: fsImpl, aiHomeDir });
    const files = discoverClineUsageFiles({ fs: fsImpl, path: pathImpl, hostHomeDir });
    const state = readCursor();
    let dirty = false;
    for (const recordPath of files) {
      let record = null;
      try {
        record = JSON.parse(fsImpl.readFileSync(recordPath, 'utf8'));
      } catch (_error) {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      summary.scanned += 1;
      const outcome = classifyClineSessionOutcome(record);
      if (!outcome) {
        summary.skipped += 1;
        continue;
      }
      const sessionId = normalizeText(record.session_id)
        || pathImpl.basename(recordPath, '.json');
      const endedAtMs = toTimestampMs(record.ended_at);
      const marker = `${record.status}:${endedAtMs}`;
      if (state[sessionId] === marker) continue;
      const startedAtMs = toTimestampMs(record.started_at);
      const resolved = ownership.resolve({
        sessionId,
        cwd: normalizeText(record.cwd),
        startedAtMs
      });
      const accountRef = normalizeText(resolved && resolved.accountRef);
      // 未归属：不写结果桶，也不推进游标（等归属可判定时再记）。
      if (!accountRef) {
        summary.unattributed += 1;
        continue;
      }
      const recorded = nodeAccountOutcomes.record({
        accountRef,
        outcome,
        atMs: endedAtMs || startedAtMs || Date.now()
      });
      state[sessionId] = marker;
      dirty = true;
      if (recorded) summary.recorded += 1;
    }
    if (dirty) persistCursor();
    return summary;
  }

  function start() {
    if (timer || !aiHomeDir || !hostHomeDir || !nodeAccountOutcomes) return false;
    tick();
    timer = setInterval(() => {
      try {
        tick();
      } catch (_error) {
        // 会话结果只影响健康统计；失败不影响主流程，下一轮重试。
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return { start, stop, tick, intervalMs, storeKey };
}

module.exports = {
  classifyClineSessionOutcome,
  createClineSessionOutcomePoller,
  DEFAULT_POLL_INTERVAL_MS
};
