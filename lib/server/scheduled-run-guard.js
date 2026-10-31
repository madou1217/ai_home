'use strict';

// **运行守卫（防抖 + 唯一）**：同一事件在**同一时刻只允许一个运行**，且两次触发之间
// 必须间隔 `debounceMs`。计划任务、手动按钮、CLI 共用这一个进程内单例，于是
// 「两个计划任务指向同一事件」「用户连点两次立即执行」「定时与手动撞在一起」都只执行一次。
//
// 为什么必须是进程内单例而不是数据库/文件锁：这些动作都是**本机副作用操作**
// （领臭鸡蛋要过阿里云无痕验证、签到要打上游），重复执行既打上游又没有幂等键；
// 而 server 只有一个进程，跨进程去重没有意义。**重启后窗口重置是刻意接受的**
// （重启本身是人为动作，且下一次触发仍受各自 schedule 约束）。
//
// 防抖窗口来自**声明**：provider 描述符的 `activity.actions[].scheduleDebounceMs`
// （见 lib/providers/contract.js），没有声明的按 `DEFAULT_DEBOUNCE_MS`。
// 被拒时返回**结构化原因**（`in_flight` / `debounced` + `nextAllowedAt`），
// 调用方据此给用户可见的「已合并/已防抖」结果，而不是静默丢弃。

const DEFAULT_DEBOUNCE_MS = 60 * 1000;

const { stableFingerprint } = require('./stable-fingerprint');

const runs = new Map();

function normalizeKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 事件 + 参数指纹 -> 运行键。
 * 参数参与指纹（同一动作的不同账号子集/不同类型是不同运行），用稳定序列化
 * 保证顺序无关；**空参数仍然返回裸 id**，老任务的历史键一个都不变。
 */
function runKey(eventId, params) {
  const id = normalizeKey(eventId);
  if (!id) return '';
  const fingerprint = stableFingerprint(params);
  return fingerprint ? `${id}#${fingerprint}` : id;
}

/**
 * 尝试获取运行权。
 *
 * @param {string} key
 * @param {object} [options]
 * @param {number} [options.debounceMs] 两次触发之间的最小间隔（<=0 表示只防并发）
 * @param {function} [options.now]
 * @returns {{ok: true, release: function}|{ok: false, reason: string, nextAllowedAt?: number, startedAt?: number}}
 */
function acquireRun(key, options = {}) {
  const normalized = normalizeKey(key);
  if (!normalized) return { ok: false, reason: 'run_key_missing' };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Math.max(0, Math.floor(Number(options.debounceMs)))
    : 0;
  const at = now();
  const current = runs.get(normalized);
  if (current && current.inFlight) {
    return { ok: false, reason: 'in_flight', startedAt: current.startedAt };
  }
  if (current && current.finishedAt > 0 && debounceMs > 0 && at - current.finishedAt < debounceMs) {
    return { ok: false, reason: 'debounced', nextAllowedAt: current.finishedAt + debounceMs };
  }
  runs.set(normalized, { inFlight: true, startedAt: at, finishedAt: 0, debounceMs });
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const entry = runs.get(normalized);
      if (!entry || entry.startedAt !== at) return;
      runs.set(normalized, { inFlight: false, startedAt: at, finishedAt: now(), debounceMs });
    }
  };
}

/** 当前是否有运行中的键（队列唯一性的可观察出口）。 */
function listRunningKeys() {
  return [...runs.entries()].filter(([, entry]) => entry.inFlight).map(([key]) => key);
}

function isRunning(key) {
  const entry = runs.get(normalizeKey(key));
  return Boolean(entry && entry.inFlight);
}

function resetRuns() {
  runs.clear();
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  runKey,
  acquireRun,
  isRunning,
  listRunningKeys,
  resetRuns
};
