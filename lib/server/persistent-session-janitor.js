'use strict';

// 空闲持久会话的「主动过期」（对应 Redis 的 active expire）。
//
// aih ss / aih <cli> sessions 打开时会做一次 lazy 回收；server 在跑时再定期扫一遍，
// 这样用户长期不打开列表，空闲会话也不会无限增长。没有 server 的机器只有 lazy 回收。
//
// 判定与淘汰策略都在 lib/runtime/persistent-session-reaper.js（纯函数），这里只负责
// 定时触发、枚举账号 socket、调用 tmux kill。

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

function createPersistentSessionJanitor(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const logger = options.logger || {};
  const intervalMs = Math.max(60 * 1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const info = typeof logger.info === 'function' ? logger.info : () => {};
  const warn = typeof logger.warn === 'function' ? logger.warn : () => {};
  let timer = null;
  let running = false;

  function runNow() {
    if (!aiHomeDir || running) return { closed: 0, failed: 0, skipped: true };
    running = true;
    try {
      const list = require('../cli/services/ai-cli/persistent-session-list');
      const reaper = require('../runtime/persistent-session-reaper');
      const summary = list.collectGlobalPersistentSessionRows({
        fs: fsImpl,
        aiHomeDir,
        processImpl: process,
        collectOnly: true,
        skipAgentTitles: true,
        silentEmpty: true,
        silentUnavailable: true
      });
      const result = reaper.reapIdleSessions(summary.rows, {
        env: process.env,
        now: options.now ? Number(options.now()) : Date.now(),
        closeSession: (row) => list.closePersistentSession(row, {
          processImpl: process,
          fs: fsImpl,
          aiHomeDir
        })
      });
      const message = reaper.describeReapResult(result);
      if (message) info(message);
      return result;
    } catch (error) {
      warn(`空闲会话回收失败：${String(error && error.message || error)}`);
      return { closed: 0, failed: 0, error: String(error && error.message || error) };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || !aiHomeDir) return false;
    timer = setInterval(runNow, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return true;
  }

  return { runNow, start, stop };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  createPersistentSessionJanitor
};
