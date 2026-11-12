'use strict';

// 额度窗口采样表：写入幂等（5 分钟分桶）、读取过滤、裁剪节流、删号级联。
// 这些性质直接决定统计页的窗口重建能不能信，必须逐条锁住。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable } = require('../lib/server/account-ref-store');
const {
  QUOTA_WINDOW_SAMPLE_COLUMNS,
  QUOTA_WINDOW_SAMPLE_BUCKET_MS,
  ensureQuotaWindowTables,
  insertQuotaWindowSample,
  maybePruneQuotaWindowSamples,
  listQuotaWindowSamples,
  listQuotaWindowScopeIndex,
  deleteQuotaWindowSamples,
  resetQuotaWindowPruneThrottle
} = require('../lib/account/quota-window-store');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PROVIDER = 'codex';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-window-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openDb(dir) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare(`
    INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ACCOUNT_REF, PROVIDER, 1, 1);
  ensureQuotaWindowTables(db);
  return db;
}

function observation(overrides = {}) {
  return {
    quotaKey: 'rate_limit:primary',
    windowLabel: '5h',
    windowMinutes: 300,
    remainingPct: 87.5,
    expectedResetAtMs: 1_800_000_000_000,
    capturedAt: 1_799_982_000_000,
    planType: 'plus',
    ...overrides
  };
}

test('建表后的列顺序与导出常量完全一致，索引齐全', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  const columns = (db.prepare('PRAGMA table_info(account_quota_window_samples)').all() || [])
    .map((row) => String(row.name));
  assert.deepEqual(columns, QUOTA_WINDOW_SAMPLE_COLUMNS);

  const indexes = (db.prepare('PRAGMA index_list(account_quota_window_samples)').all() || [])
    .map((row) => String(row.name));
  assert.ok(indexes.includes('idx_quota_window_samples_account_key_time'));
  assert.ok(indexes.includes('idx_quota_window_samples_time'));
  db.close();
});

test('同一 5 分钟桶重复写入只保留第一条', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  const capturedAt = 1_799_982_000_000;

  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt, remainingPct: 90 })), true);
  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: capturedAt + 30_000, remainingPct: 80 })), false);

  const rows = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, { quotaKey: 'rate_limit:primary', windowMinutes: 300 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].capturedAtMs, capturedAt, '桶内保留第一条的真实采集时刻');
  assert.equal(rows[0].remainingPct, 90);
  db.close();
});

test('跨桶写入各占一行', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  const capturedAt = 1_799_982_000_000;
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt }));
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: capturedAt + QUOTA_WINDOW_SAMPLE_BUCKET_MS }));

  const rows = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(rows.length, 2);
  db.close();
});

test('缺 windowMinutes / expectedResetAtMs / capturedAt 的观测不落库', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ windowMinutes: 0 })), false);
  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ expectedResetAtMs: 0 })), false);
  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: 0 })), false);
  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ quotaKey: '' })), false);
  assert.equal(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}).length, 0);
  db.close();
});

test('remainingPct 缺失仍可落库（只给 resetAt 的 provider）', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  assert.equal(insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ remainingPct: null })), true);
  const rows = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remainingPct, null);
  db.close();
});

test('listQuotaWindowSamples 按 quotaKey + windowMinutes + 区间过滤并按时间升序', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  const base = 1_799_982_000_000;
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: base + 3 * QUOTA_WINDOW_SAMPLE_BUCKET_MS }));
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: base }));
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: base + QUOTA_WINDOW_SAMPLE_BUCKET_MS, quotaKey: 'rate_limit:secondary', windowMinutes: 10080, windowLabel: '7days' }));

  const primary = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {
    quotaKey: 'rate_limit:primary',
    windowMinutes: 300,
    fromMs: base,
    toMs: base + 2 * QUOTA_WINDOW_SAMPLE_BUCKET_MS
  });
  assert.equal(primary.length, 1);
  assert.equal(primary[0].capturedAtMs, base);

  const all = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((row) => row.capturedAtMs), [base, base + QUOTA_WINDOW_SAMPLE_BUCKET_MS, base + 3 * QUOTA_WINDOW_SAMPLE_BUCKET_MS]);
  db.close();
});

test('listQuotaWindowScopeIndex 按 quotaKey + 窗口长度分组', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  const base = 1_799_982_000_000;
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: base }));
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: base + QUOTA_WINDOW_SAMPLE_BUCKET_MS }));
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: base, quotaKey: 'rate_limit:secondary', windowMinutes: 10080, windowLabel: '7days' }));

  const index = listQuotaWindowScopeIndex(fs, dir, ACCOUNT_REF);
  assert.equal(index.length, 2);
  assert.deepEqual(index.map((row) => [row.quotaKey, row.windowMinutes, row.sampleCount]), [
    ['rate_limit:primary', 300, 2],
    ['rate_limit:secondary', 10080, 1]
  ]);
  assert.equal(index[0].firstCapturedAtMs, base);
  assert.equal(index[0].lastCapturedAtMs, base + QUOTA_WINDOW_SAMPLE_BUCKET_MS);
  db.close();
});

test('裁剪删掉过期样本、保留新样本，并受节流保护', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  const now = 1_800_000_000_000;
  const oldCapturedAt = now - 130 * 24 * 60 * 60 * 1000;
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: oldCapturedAt }), now);
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: now }), now);

  resetQuotaWindowPruneThrottle();
  assert.equal(maybePruneQuotaWindowSamples(db, now), 1);
  assert.equal(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}).length, 1, '只留下未过期的一条');

  // 节流窗口内再调不删；force 才生效。
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation({ capturedAt: oldCapturedAt + QUOTA_WINDOW_SAMPLE_BUCKET_MS }), now);
  assert.equal(maybePruneQuotaWindowSamples(db, now + 60_000), 0);
  assert.equal(maybePruneQuotaWindowSamples(db, now + 60_000, { force: true }), 1);
  db.close();
});

test('样本表还没建时读路径返回空数组而不是抛错', (t) => {
  const dir = tmp(t);
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare(`
    INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ACCOUNT_REF, PROVIDER, 1, 1);
  db.close();

  assert.deepEqual(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}), []);
  assert.deepEqual(listQuotaWindowScopeIndex(fs, dir, ACCOUNT_REF), []);
});

test('删除账号时样本级联清理', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation());
  assert.equal(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}).length, 1);

  db.prepare('DELETE FROM account_refs WHERE account_ref = ?').run(ACCOUNT_REF);
  assert.equal(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}).length, 0);
  db.close();
});

test('deleteQuotaWindowSamples 只清指定账号', (t) => {
  const dir = tmp(t);
  const db = openDb(dir);
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, observation());
  assert.equal(deleteQuotaWindowSamples(fs, dir, ACCOUNT_REF), 1);
  assert.equal(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}).length, 0);
  db.close();
});
