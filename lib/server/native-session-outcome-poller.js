'use strict';

// 原生 CLI 会话结果 → 账号结果桶（健康统计的「会话证据」来源），Template Method。
//
// 为什么需要：健康统计原本只有「上游 attempt 结果」一种证据。只用原生 CLI 驱动的账号
// （`aih cline <id>` / `aih kiro <id>`，不经过网关）没有任何 attempt，状态条因此永远是空的。
// 各 CLI 会把每轮/每段会话的终态写进自己的会话文件，这是该账号可观测的、非猜测的结果证据。
//
// 模板固定的部分（所有 provider 一致）：
//   * 幂等：每个观察 key 只在 marker 变化时记一次，游标持久化在 app-state KV；
//   * 未归属（accountRef 为空）的观察不写结果桶、**不推进游标**——等归属可判定时再记，
//     宁可少记也不张冠李戴；
//   * outcome 为空（取消 / 进行中 / 未知）不记；
//   * 定时轮询 + 失败吞掉（只影响健康统计，不影响主流程）。
// provider 只提供 collect()：返回本轮的观察 [{ key, marker, outcome, atMs, accountRef }]。

const { readJsonValue, writeJsonValue } = require('./app-state-store');

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 30 * 1000;
// 游标上限：超出后按插入顺序丢最旧的条目（会话记录本身也有清理）。
const MAX_TRACKED_OBSERVATIONS = 4000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * @param {{
 *   fs?: object, aiHomeDir: string, nodeAccountOutcomes: {record: Function},
 *   storeKey: string, intervalMs?: number, collect: () => Array<object>,
 *   readJsonValue?: Function, writeJsonValue?: Function
 * }} options
 */
function createNativeSessionOutcomePoller(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const nodeAccountOutcomes = options.nodeAccountOutcomes || null;
  const collect = typeof options.collect === 'function' ? options.collect : () => [];
  const storeKey = normalizeText(options.storeKey);
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const readValue = typeof options.readJsonValue === 'function' ? options.readJsonValue : readJsonValue;
  const writeValue = typeof options.writeJsonValue === 'function' ? options.writeJsonValue : writeJsonValue;
  const enabled = Boolean(aiHomeDir && storeKey && nodeAccountOutcomes && typeof nodeAccountOutcomes.record === 'function');

  let timer = null;
  let cursor = null;

  function readCursor() {
    if (cursor) return cursor;
    const raw = readValue(fsImpl, aiHomeDir, storeKey);
    cursor = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    return cursor;
  }

  function persistCursor() {
    const entries = Object.entries(cursor);
    if (entries.length > MAX_TRACKED_OBSERVATIONS) {
      cursor = Object.fromEntries(entries.slice(entries.length - MAX_TRACKED_OBSERVATIONS));
    }
    writeValue(fsImpl, aiHomeDir, storeKey, cursor);
  }

  function tick() {
    const summary = { scanned: 0, recorded: 0, unattributed: 0, skipped: 0 };
    if (!enabled) return summary;
    const state = readCursor();
    let dirty = false;
    for (const observation of collect() || []) {
      if (!observation || typeof observation !== 'object') continue;
      summary.scanned += 1;
      const key = normalizeText(observation.key);
      const outcome = normalizeText(observation.outcome);
      if (!key || !outcome) {
        summary.skipped += 1;
        continue;
      }
      const marker = normalizeText(observation.marker) || '1';
      if (state[key] === marker) continue;
      const accountRef = normalizeText(observation.accountRef);
      if (!accountRef) {
        summary.unattributed += 1;
        continue;
      }
      const recorded = nodeAccountOutcomes.record({
        accountRef,
        outcome,
        atMs: Number(observation.atMs) || Date.now()
      });
      state[key] = marker;
      dirty = true;
      if (recorded) summary.recorded += 1;
    }
    if (dirty) persistCursor();
    return summary;
  }

  function start() {
    if (timer || !enabled) return false;
    try {
      tick();
    } catch (_error) {
      // 首轮失败不阻止定时器启动。
    }
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
  createNativeSessionOutcomePoller,
  DEFAULT_POLL_INTERVAL_MS
};
