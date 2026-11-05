'use strict';

// 采样钩子必须绕开重置状态机的两条早退：
//   · 首次观测只建基线、不产出事件；
//   · 乱序/重复 capturedAt 直接丢弃。
// 这两条对「重置判定」是对的，但会让统计页丢掉观测本身。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable } = require('../lib/server/account-ref-store');
const { detectAndRecordQuotaResets } = require('../lib/account/quota-reset-detector');
const {
  listQuotaWindowSamples,
  resetQuotaWindowPruneThrottle
} = require('../lib/account/quota-window-store');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PROVIDER = 'codex';
const WINDOW_MS = 300 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 10, 5, 0, 0, 0);
const BUCKET_MS = 5 * 60 * 1000;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-window-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedAccount(dir) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare(`
    INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ACCOUNT_REF, PROVIDER, 1, 1);
  db.close();
}

function buildSnapshot(capturedAt, remainingPct = 90) {
  return {
    provider: PROVIDER,
    capturedAt,
    entries: [{
      bucket: 'primary',
      windowMinutes: 300,
      window: '5h',
      remainingPct,
      resetAtMs: capturedAt + WINDOW_MS
    }]
  };
}

test('首次观测（只建基线、不产生事件）也会落样本', (t) => {
  const dir = tmp(t);
  seedAccount(dir);
  resetQuotaWindowPruneThrottle();

  const events = detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS));
  assert.equal(events.length, 0, '首次观测不产生重置事件');

  const samples = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(samples.length, 1);
  assert.equal(samples[0].quotaKey, 'rate_limit:primary');
  assert.equal(samples[0].windowMinutes, 300);
  assert.equal(samples[0].remainingPct, 90);
  assert.equal(samples[0].capturedAtMs, BASE_MS);
});

test('同一 5 分钟桶内重复快照不重复落样本', (t) => {
  const dir = tmp(t);
  seedAccount(dir);
  resetQuotaWindowPruneThrottle();

  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS));
  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS + 60_000, 85));

  const samples = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(samples.length, 1);
  assert.equal(samples[0].remainingPct, 90, '保留桶内第一条观测');
});

test('跨桶快照各落一条', (t) => {
  const dir = tmp(t);
  seedAccount(dir);
  resetQuotaWindowPruneThrottle();

  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS));
  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS + BUCKET_MS, 80));

  const samples = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((row) => row.remainingPct), [90, 80]);
});

test('乱序快照（capturedAt 早于上次）仍会落样本', (t) => {
  const dir = tmp(t);
  seedAccount(dir);
  resetQuotaWindowPruneThrottle();

  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS + 2 * BUCKET_MS));
  // 状态机对 now <= lastCapturedAtMs 直接 return，但观测本身必须留下。
  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, buildSnapshot(BASE_MS));

  const samples = listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {});
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((row) => row.capturedAtMs), [BASE_MS, BASE_MS + 2 * BUCKET_MS]);
});

test('没有 resetAtMs 的条目不会写出无法归窗的样本', (t) => {
  const dir = tmp(t);
  seedAccount(dir);
  resetQuotaWindowPruneThrottle();

  detectAndRecordQuotaResets(fs, dir, ACCOUNT_REF, {
    provider: PROVIDER,
    capturedAt: BASE_MS,
    entries: [{ bucket: 'primary', windowMinutes: 300, window: '5h', remainingPct: 42 }]
  });

  assert.equal(listQuotaWindowSamples(fs, dir, ACCOUNT_REF, {}).length, 0);
});
