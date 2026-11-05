'use strict';

// 额度窗口采样：把每次用量快照里的额度条目落成「连续观测」，供账号额度统计页
// 重建窗口（见 lib/account/quota-window-reconstruction.js）。
//
// 为什么不复用 account_quota_reset_events：
//   · 重置事件只在「回满 100%」时产生，是稀疏的状态机产物，答不了「这个 5h 窗口用了多少」；
//   · 事件是永久历史，采样是可裁剪的高频日志，两者的生命周期和写入频率完全不同。
//
// 为什么按 5 分钟分桶：
//   同一分钟内重复写快照是常态（CLI 探针 + 网关刷新 + 手动刷新），逐条落库没有额外信息量。
//   分桶把单账号单 quotaKey 的上限压到 288 行/天，同时保留桶内第一条的真实 captured_at_ms。

const {
  ensureExactTableSchema
} = require('../server/app-state-store');
const { ensureAccountRefsTable, isAccountRef } = require('../server/account-ref-store');
const { withDatabase } = require('./quota-reset-store');

const QUOTA_WINDOW_SAMPLE_TABLE = 'account_quota_window_samples';
const QUOTA_WINDOW_SAMPLE_BUCKET_MS = 5 * 60 * 1000;
// 90 天查询范围 + 30 天窗口，留 120 天足够回溯；再老的样本没有页面会读。
const QUOTA_WINDOW_SAMPLE_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
const QUOTA_WINDOW_SAMPLE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const QUOTA_WINDOW_SAMPLE_PRUNE_BATCH = 5000;
const MAX_QUOTA_WINDOW_SAMPLE_ROWS = 60000;

// 列顺序必须与 DDL 完全一致：ensureExactTableSchema 会逐列比对。
const QUOTA_WINDOW_SAMPLE_COLUMNS = Object.freeze([
  'id',
  'account_ref',
  'provider',
  'quota_key',
  'window_label',
  'window_minutes',
  'remaining_pct',
  'expected_reset_at_ms',
  'captured_at_ms',
  'captured_bucket',
  'plan_type',
  'created_at_ms'
]);

let lastPruneAtMs = 0;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function optionalFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function createQuotaWindowSamplesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${QUOTA_WINDOW_SAMPLE_TABLE} (
      id INTEGER PRIMARY KEY,
      account_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      quota_key TEXT NOT NULL,
      window_label TEXT,
      window_minutes INTEGER NOT NULL,
      remaining_pct REAL,
      expected_reset_at_ms INTEGER NOT NULL,
      captured_at_ms INTEGER NOT NULL,
      captured_bucket INTEGER NOT NULL,
      plan_type TEXT,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (account_ref, quota_key, window_minutes, captured_bucket),
      FOREIGN KEY (account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function ensureQuotaWindowTables(db) {
  ensureAccountRefsTable(db);
  ensureExactTableSchema(db, {
    tableName: QUOTA_WINDOW_SAMPLE_TABLE,
    columns: QUOTA_WINDOW_SAMPLE_COLUMNS,
    primaryKey: ['id'],
    uniqueKeys: [['account_ref', 'quota_key', 'window_minutes', 'captured_bucket']],
    create: () => createQuotaWindowSamplesTable(db),
    errorCode: 'quota_window_samples_schema_invalid'
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_quota_window_samples_account_key_time
      ON ${QUOTA_WINDOW_SAMPLE_TABLE} (account_ref, quota_key, captured_at_ms)
  `);
  // 裁剪按 captured_at_ms 单列扫；没有它每次 prune 都是全表。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_quota_window_samples_time
      ON ${QUOTA_WINDOW_SAMPLE_TABLE} (captured_at_ms)
  `);
}

/**
 * 把一条额度观测翻成待写入的样本。
 *
 * 缺 windowMinutes / expectedResetAtMs / capturedAt 的观测无法归到任何窗口，
 * 写进去只是垃圾 —— 直接返回 null，由调用方跳过。
 */
function normalizeQuotaWindowSample(accountRef, provider, observation) {
  const normalizedRef = text(accountRef);
  const normalizedProvider = text(provider).toLowerCase();
  const quotaKey = text(observation && observation.quotaKey);
  const windowMinutes = positiveInteger(observation && observation.windowMinutes);
  const expectedResetAtMs = positiveInteger(observation && observation.expectedResetAtMs);
  const capturedAtMs = positiveInteger(observation && observation.capturedAt);
  if (!isAccountRef(normalizedRef) || !normalizedProvider || !quotaKey) return null;
  if (!windowMinutes || !expectedResetAtMs || !capturedAtMs) return null;
  return {
    accountRef: normalizedRef,
    provider: normalizedProvider,
    quotaKey,
    windowLabel: text(observation && observation.windowLabel) || null,
    windowMinutes,
    remainingPct: optionalFloat(observation && observation.remainingPct),
    expectedResetAtMs,
    capturedAtMs,
    capturedBucket: Math.floor(capturedAtMs / QUOTA_WINDOW_SAMPLE_BUCKET_MS),
    planType: text(observation && observation.planType) || null
  };
}

/**
 * 幂等写入：同一账号 + quotaKey + 窗口长度 + 5 分钟桶只保留第一条。
 *
 * @returns {boolean} true 表示真的插入了新行
 */
function insertQuotaWindowSample(db, accountRef, provider, observation, nowMs = Date.now()) {
  const sample = normalizeQuotaWindowSample(accountRef, provider, observation);
  if (!sample) return false;
  const result = db.prepare(`
    INSERT INTO ${QUOTA_WINDOW_SAMPLE_TABLE} (
      account_ref, provider, quota_key, window_label, window_minutes,
      remaining_pct, expected_reset_at_ms, captured_at_ms, captured_bucket,
      plan_type, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_ref, quota_key, window_minutes, captured_bucket) DO NOTHING
  `).run(
    sample.accountRef,
    sample.provider,
    sample.quotaKey,
    sample.windowLabel,
    sample.windowMinutes,
    sample.remainingPct,
    sample.expectedResetAtMs,
    sample.capturedAtMs,
    sample.capturedBucket,
    sample.planType,
    positiveInteger(nowMs) || Date.now()
  );
  return Number(result && result.changes) > 0;
}

/**
 * 裁剪过期样本。节流是模块级的：快照写入是热路径，每 6 小时最多扫一次。
 * 失败由调用方吞掉（样本是尽力而为的诊断数据，不能回滚重置事件）。
 */
function maybePruneQuotaWindowSamples(db, nowMs = Date.now(), options = {}) {
  const now = positiveInteger(nowMs) || Date.now();
  if (options.force !== true
    && lastPruneAtMs > 0
    && now - lastPruneAtMs < QUOTA_WINDOW_SAMPLE_PRUNE_INTERVAL_MS) {
    return 0;
  }
  lastPruneAtMs = now;
  const cutoff = now - QUOTA_WINDOW_SAMPLE_RETENTION_MS;
  const result = db.prepare(`
    DELETE FROM ${QUOTA_WINDOW_SAMPLE_TABLE}
    WHERE id IN (
      SELECT id FROM ${QUOTA_WINDOW_SAMPLE_TABLE}
      WHERE captured_at_ms < ?
      LIMIT ?
    )
  `).run(cutoff, QUOTA_WINDOW_SAMPLE_PRUNE_BATCH);
  return Number(result && result.changes) || 0;
}

function mapSampleRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountRef: text(row.account_ref),
    provider: text(row.provider),
    quotaKey: text(row.quota_key),
    windowLabel: text(row.window_label),
    windowMinutes: Number(row.window_minutes) || 0,
    remainingPct: optionalFloat(row.remaining_pct),
    expectedResetAtMs: Number(row.expected_reset_at_ms) || 0,
    capturedAtMs: Number(row.captured_at_ms) || 0,
    capturedBucket: Number(row.captured_bucket) || 0,
    planType: text(row.plan_type) || null,
    createdAtMs: Number(row.created_at_ms) || 0
  };
}

function listQuotaWindowSamples(fs, aiHomeDir, accountRef, options = {}) {
  const normalizedRef = text(accountRef);
  if (!isAccountRef(normalizedRef)) return [];
  const quotaKey = text(options.quotaKey);
  const windowMinutes = positiveInteger(options.windowMinutes);
  const fromMs = positiveInteger(options.fromMs);
  const toMs = positiveInteger(options.toMs);
  const limit = Math.max(1, Math.min(
    MAX_QUOTA_WINDOW_SAMPLE_ROWS,
    Number(options.limit) || MAX_QUOTA_WINDOW_SAMPLE_ROWS
  ));

  return withDatabase(fs, aiHomeDir, (db) => {
    // 读路径也要确保表存在：全新安装还没写过快照时，SELECT 会直接报 no such table。
    // CREATE TABLE IF NOT EXISTS 是微秒级，比「先探测表是否存在」更简单。
    ensureQuotaWindowTables(db);
    let sql = `
      SELECT ${QUOTA_WINDOW_SAMPLE_COLUMNS.join(', ')}
      FROM ${QUOTA_WINDOW_SAMPLE_TABLE}
      WHERE account_ref = ?
    `;
    const params = [normalizedRef];
    if (quotaKey) {
      sql += ' AND quota_key = ? ';
      params.push(quotaKey);
    }
    if (windowMinutes) {
      sql += ' AND window_minutes = ? ';
      params.push(windowMinutes);
    }
    if (fromMs) {
      sql += ' AND captured_at_ms >= ? ';
      params.push(fromMs);
    }
    if (toMs) {
      sql += ' AND captured_at_ms <= ? ';
      params.push(toMs);
    }
    sql += ' ORDER BY captured_at_ms ASC, id ASC LIMIT ? ';
    params.push(limit);
    return (db.prepare(sql).all(...params) || []).map(mapSampleRow).filter(Boolean);
  }, { createIfMissing: false }) || [];
}

/**
 * 账号下有哪些 (quotaKey, windowMinutes) 组合 —— 统计页用它决定三个维度哪些可用。
 */
function listQuotaWindowScopeIndex(fs, aiHomeDir, accountRef) {
  const normalizedRef = text(accountRef);
  if (!isAccountRef(normalizedRef)) return [];
  return withDatabase(fs, aiHomeDir, (db) => {
    ensureQuotaWindowTables(db);
    const rows = db.prepare(`
      SELECT
        quota_key,
        window_minutes,
        MAX(window_label) AS window_label,
        COUNT(*) AS sample_count,
        MIN(captured_at_ms) AS first_captured_at_ms,
        MAX(captured_at_ms) AS last_captured_at_ms
      FROM ${QUOTA_WINDOW_SAMPLE_TABLE}
      WHERE account_ref = ?
      GROUP BY quota_key, window_minutes
      ORDER BY window_minutes ASC, quota_key ASC
    `).all(normalizedRef) || [];
    return rows.map((row) => ({
      quotaKey: text(row.quota_key),
      windowMinutes: Number(row.window_minutes) || 0,
      windowLabel: text(row.window_label),
      sampleCount: Number(row.sample_count) || 0,
      firstCapturedAtMs: Number(row.first_captured_at_ms) || 0,
      lastCapturedAtMs: Number(row.last_captured_at_ms) || 0
    })).filter((row) => row.quotaKey && row.windowMinutes > 0);
  }, { createIfMissing: false }) || [];
}

function deleteQuotaWindowSamples(fs, aiHomeDir, accountRef) {
  const normalizedRef = text(accountRef);
  if (!isAccountRef(normalizedRef)) return 0;
  return withDatabase(fs, aiHomeDir, (db) => {
    const result = db.prepare(
      `DELETE FROM ${QUOTA_WINDOW_SAMPLE_TABLE} WHERE account_ref = ?`
    ).run(normalizedRef);
    return Number(result && result.changes) || 0;
  }, { createIfMissing: false }) || 0;
}

function resetQuotaWindowPruneThrottle() {
  lastPruneAtMs = 0;
}

module.exports = {
  QUOTA_WINDOW_SAMPLE_TABLE,
  QUOTA_WINDOW_SAMPLE_COLUMNS,
  QUOTA_WINDOW_SAMPLE_BUCKET_MS,
  QUOTA_WINDOW_SAMPLE_RETENTION_MS,
  QUOTA_WINDOW_SAMPLE_PRUNE_INTERVAL_MS,
  QUOTA_WINDOW_SAMPLE_PRUNE_BATCH,
  ensureQuotaWindowTables,
  normalizeQuotaWindowSample,
  insertQuotaWindowSample,
  maybePruneQuotaWindowSamples,
  listQuotaWindowSamples,
  listQuotaWindowScopeIndex,
  deleteQuotaWindowSamples,
  resetQuotaWindowPruneThrottle
};
