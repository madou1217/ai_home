'use strict';

const { withTransaction } = require('./database');
const { PREWARM_RETAINED_EVENT_WINDOW } = require('./event-repository');
const { compactTimelineItem } = require('./timeline-item-compaction');

// 一次性回填：把已存的历史导入行收敛成与新写入相同的形状，并去掉历史上积累的副本。
// 只动 `history-*` 行——它们是 codex thread/read 的投影，可以从原生转写重新推导；
// 实时运行写入的行是唯一副本，一行都不碰。按会话逐个处理，每个会话一个小事务；
// 全部成功后才写完成标记，中途失败下次启动从头幂等重跑。
const COMPACTION_MARKER = 'chat_runtime.timeline_history_compaction.v1';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutUpdatedAt(payload) {
  const { updatedAt: _updatedAt, ...item } = payload.item || {};
  return stableJson({ ...payload, item });
}

function compactHistoryPayloads(db, sessionId, stats) {
  const rows = db.prepare(`
    SELECT event_id, payload_json FROM chat_runtime_events
    WHERE session_id = ? AND event_id LIKE 'history-%' AND type LIKE 'timeline.item.%'
  `).all(sessionId);
  const update = db.prepare('UPDATE chat_runtime_events SET payload_json = ? WHERE event_id = ?');
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    const compacted = compactTimelineItem(payload.item);
    if (compacted === payload.item) continue;
    const next = JSON.stringify({ ...payload, item: compacted });
    stats.bytesSaved += row.payload_json.length - next.length;
    stats.rowsCompacted += 1;
    update.run(next, row.event_id);
  }
}

// 同一 item 相邻的两条历史行若只差 updatedAt（回合进行中导入一次、结束后又导入一次），
// 保留较早那行（item 在时间线里的位置由它的最小 seq 决定），把较新的 payload 写回它，
// 删除较新那行。中间夹着实时行的不合并。
function mergeStaleRepeats(db, sessionId, stats) {
  const rows = db.prepare(`
    SELECT event_id, item_id, type, payload_json FROM chat_runtime_events
    WHERE session_id = ? AND item_id IS NOT NULL AND type LIKE 'timeline.item.%'
    ORDER BY item_id, seq
  `).all(sessionId);
  const update = db.prepare('UPDATE chat_runtime_events SET payload_json = ? WHERE event_id = ?');
  const remove = db.prepare('DELETE FROM chat_runtime_events WHERE event_id = ?');
  let keeper = null;
  for (const row of rows) {
    const isHistory = String(row.event_id).startsWith('history-');
    if (keeper && keeper.item_id === row.item_id && isHistory && keeper.type === row.type
      && withoutUpdatedAt(JSON.parse(keeper.payload_json)) === withoutUpdatedAt(JSON.parse(row.payload_json))) {
      update.run(row.payload_json, keeper.event_id);
      remove.run(row.event_id);
      stats.bytesSaved += row.payload_json.length;
      stats.rowsMerged += 1;
      keeper = { ...keeper, payload_json: row.payload_json };
      continue;
    }
    keeper = isHistory ? row : null;
  }
}

function pruneStalePrewarm(db, sessionId, stats) {
  const result = db.prepare(`
    DELETE FROM chat_runtime_events
    WHERE session_id = ? AND type LIKE 'runtime.prewarm.%'
      AND seq <= (SELECT last_event_seq FROM chat_runtime_sessions WHERE session_id = ?) - ?
  `).run(sessionId, sessionId, PREWARM_RETAINED_EVENT_WINDOW);
  stats.prewarmPruned += Number(result.changes || 0);
}

function readMarker(db) {
  try {
    return Boolean(db.prepare('SELECT 1 AS done FROM app_kv WHERE key = ?').get(COMPACTION_MARKER));
  } catch (_error) {
    return false;
  }
}

function emptyStats() {
  return { skipped: false, sessions: 0, rowsCompacted: 0, rowsMerged: 0, prewarmPruned: 0, bytesSaved: 0 };
}

function listSessionIds(db) {
  return db.prepare('SELECT session_id FROM chat_runtime_sessions ORDER BY session_id').all()
    .map((row) => row.session_id);
}

function compactSession(db, sessionId, stats) {
  withTransaction(db, () => {
    compactHistoryPayloads(db, sessionId, stats);
    mergeStaleRepeats(db, sessionId, stats);
    pruneStalePrewarm(db, sessionId, stats);
  });
  stats.sessions += 1;
}

function writeMarker(db, stats) {
  db.prepare(`
    INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(COMPACTION_MARKER, JSON.stringify(stats), Date.now());
}

/**
 * 同步执行全部会话（测试与离线校验用）。
 * @returns {{ skipped: boolean, sessions: number, rowsCompacted: number, rowsMerged: number,
 *   prewarmPruned: number, bytesSaved: number }}
 */
function compactStoredTimelineHistory(db) {
  const stats = emptyStats();
  if (readMarker(db)) return { ...stats, skipped: true };
  for (const sessionId of listSessionIds(db)) compactSession(db, sessionId, stats);
  writeMarker(db, stats);
  return stats;
}

// 服务运行时：启动后延迟执行，每个会话之间让出事件循环（实测 119 个会话共约 25 秒，
// 一次性同步跑会卡住服务）。store 关闭即取消；中途失败不写标记，下次启动幂等重跑。
const DEFAULT_COMPACTION_DELAY_MS = 60_000;

function scheduleTimelineHistoryCompaction(getDb, options = {}) {
  let cancelled = false;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : DEFAULT_COMPACTION_DELAY_MS;
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
  const run = async () => {
    try {
      const db = getDb();
      if (cancelled || !db || readMarker(db)) return;
      const stats = emptyStats();
      for (const sessionId of listSessionIds(db)) {
        if (cancelled || !getDb()) return;
        compactSession(db, sessionId, stats);
        await yieldToEventLoop();
      }
      if (cancelled || !getDb()) return;
      writeMarker(db, stats);
      log(stats);
    } catch (error) {
      log(null, error);
    }
  };
  const timer = setTimeout(() => { run(); }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    }
  };
}

module.exports = {
  COMPACTION_MARKER,
  compactStoredTimelineHistory,
  scheduleTimelineHistoryCompaction
};
