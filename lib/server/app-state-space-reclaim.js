'use strict';

// 把 app-state.db 里的空闲页还给磁盘。删除（清理预热事件、合并重复行等）腾出的页
// 默认只留在库里供后续写入复用，文件不会变小；auto_vacuum=INCREMENTAL 的库可以用
// `PRAGMA incremental_vacuum` 按需截短文件。
//
// 老库的 auto_vacuum 是 NONE，切换到 INCREMENTAL 需要一次全量 VACUUM（独占、要停服），
// 不能在运行时自动做；这类库这里什么都不做，等运维做过那次 VACUUM 后自然生效。

const AUTO_VACUUM_INCREMENTAL = 2;
const DEFAULT_INITIAL_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function pragmaNumber(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return Number(row && row[name]) || 0;
}

/**
 * @returns {{ enabled: boolean, reclaimedPages: number }}
 */
function reclaimFreePages(db) {
  if (pragmaNumber(db, 'auto_vacuum') !== AUTO_VACUUM_INCREMENTAL) return { enabled: false, reclaimedPages: 0 };
  const before = pragmaNumber(db, 'freelist_count');
  if (before === 0) return { enabled: true, reclaimedPages: 0 };
  db.exec('PRAGMA incremental_vacuum');
  return { enabled: true, reclaimedPages: before - pragmaNumber(db, 'freelist_count') };
}

function scheduleAppStateSpaceReclaim(getDb, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const initialDelayMs = Number.isFinite(options.initialDelayMs) ? options.initialDelayMs : DEFAULT_INITIAL_DELAY_MS;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_INTERVAL_MS;
  let interval = null;
  const run = () => {
    const db = getDb();
    if (!db) return;
    try {
      const result = reclaimFreePages(db);
      if (result.reclaimedPages > 0) log(result);
    } catch (error) {
      log(null, error);
    }
  };
  const initial = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
  }, initialDelayMs);
  if (typeof initial.unref === 'function') initial.unref();
  return {
    cancel() {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    }
  };
}

module.exports = {
  reclaimFreePages,
  scheduleAppStateSpaceReclaim
};
