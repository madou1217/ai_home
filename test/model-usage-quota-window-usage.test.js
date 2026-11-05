'use strict';

// 窗口用量聚合：一次 SQL 按窗口边界分桶，左闭右开，不重复计数；
// 成本未知必须表达成 null，不能写成 0（否则「免费模型」和「查不到价」看起来一样）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { openAppStateDatabase } = require('../lib/server/app-state-store');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 10, 5, 0, 0, 0);
const WINDOW_MS = 5 * HOUR;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-window-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return openModelUsageStore({
    fs,
    aiHomeDir: dir,
    // 定价器注入成确定值：测试只关心「有没有定价」，不关心真实价目表。
    modelPricingResolver: {
      resolve: (target) => (
        target && target.model === 'priced-model' ? { pricing: { model: 'priced-model' } } : null
      )
    }
  });
}

function insert(store, { timestampMs, tokens = 100, costUsd = 0.5, model = 'priced-model', eventKey }) {
  store.insertUsage({
    eventKey: eventKey || `${model}:${timestampMs}:${Math.random()}`,
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    model,
    totalTokens: tokens,
    costUsd,
    timestampMs
  });
}

test('跨窗口聚合 tokens / 成本 / 请求数', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  const windows = [
    { index: 0, startMs: BASE, endMs: BASE + WINDOW_MS },
    { index: 1, startMs: BASE + WINDOW_MS, endMs: BASE + 2 * WINDOW_MS },
    { index: 2, startMs: BASE + 2 * WINDOW_MS, endMs: BASE + 3 * WINDOW_MS }
  ];

  insert(store, { timestampMs: BASE, eventKey: 'a' });
  insert(store, { timestampMs: BASE + HOUR, eventKey: 'b' });
  insert(store, { timestampMs: BASE + WINDOW_MS, eventKey: 'c' });
  insert(store, { timestampMs: BASE + WINDOW_MS + HOUR, eventKey: 'd' });
  insert(store, { timestampMs: BASE + 2 * WINDOW_MS, eventKey: 'e' });
  insert(store, { timestampMs: BASE + 2 * WINDOW_MS + HOUR, eventKey: 'f' });

  const usage = store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows });
  assert.equal(usage.length, 3);
  assert.deepEqual(usage.map((row) => [row.index, row.tokens, row.requestCount]), [
    [0, 200, 2],
    [1, 200, 2],
    [2, 200, 2]
  ]);
  assert.deepEqual(usage.map((row) => row.costUsd), [1, 1, 1]);
  assert.ok(usage.every((row) => row.costKnown === true));

  const total = usage.reduce((sum, row) => sum + row.tokens, 0);
  assert.equal(total, 600, '窗口之间不重复计数');
  store.close();
});

test('边界左闭右开：startMs 归当前窗口，endMs 归下一个窗口', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  const windows = [
    { index: 0, startMs: BASE, endMs: BASE + WINDOW_MS },
    { index: 1, startMs: BASE + WINDOW_MS, endMs: BASE + 2 * WINDOW_MS }
  ];
  insert(store, { timestampMs: BASE + WINDOW_MS, eventKey: 'boundary' });

  const usage = store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows });
  assert.equal(usage[0].tokens, 0);
  assert.equal(usage[1].tokens, 100);
  store.close();
});

test('窗口外的行不计入任何窗口', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  const windows = [{ index: 0, startMs: BASE, endMs: BASE + WINDOW_MS }];
  insert(store, { timestampMs: BASE - HOUR, eventKey: 'before' });
  insert(store, { timestampMs: BASE + WINDOW_MS, eventKey: 'after' });

  const usage = store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows });
  assert.equal(usage[0].tokens, 0);
  assert.equal(usage[0].requestCount, 0);
  store.close();
});

test('其它账号的行不会串进来', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  const windows = [{ index: 0, startMs: BASE, endMs: BASE + WINDOW_MS }];
  store.insertUsage({
    eventKey: 'other',
    provider: 'codex',
    accountRef: 'acct_ffffffffffffffffffff',
    model: 'priced-model',
    totalTokens: 999,
    costUsd: 9,
    timestampMs: BASE
  });

  const usage = store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows });
  assert.equal(usage[0].tokens, 0);
  store.close();
});

test('有未定价模型时该窗口成本未知（null），不是 0', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  const windows = [
    { index: 0, startMs: BASE, endMs: BASE + WINDOW_MS },
    { index: 1, startMs: BASE + WINDOW_MS, endMs: BASE + 2 * WINDOW_MS }
  ];
  insert(store, { timestampMs: BASE, model: 'priced-model', eventKey: 'priced' });
  insert(store, { timestampMs: BASE + WINDOW_MS, model: 'unpriced-model', costUsd: 0, eventKey: 'unpriced' });

  const usage = store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows });
  assert.equal(usage[0].costKnown, true);
  assert.equal(usage[0].costUsd, 0.5);
  assert.equal(usage[1].costKnown, false);
  assert.equal(usage[1].costUsd, null);
  store.close();
});

test('空窗口返回 0 且成本视为已知', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  const windows = [{ index: 7, startMs: BASE, endMs: BASE + WINDOW_MS }];
  const usage = store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows });
  assert.deepEqual(usage, [{ index: 7, tokens: 0, costUsd: 0, costKnown: true, requestCount: 0 }]);
  store.close();
});

test('非法窗口区间被跳过，空输入返回空数组', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  assert.deepEqual(store.queryAccountQuotaWindowUsage({ accountRef: ACCOUNT_REF, windows: [] }), []);
  assert.deepEqual(store.queryAccountQuotaWindowUsage({
    accountRef: ACCOUNT_REF,
    windows: [{ index: 0, startMs: BASE, endMs: BASE }]
  }), []);
  store.close();
});

test('账号 + 时间的联合索引已建立', (t) => {
  const dir = tmp(t);
  const store = openStore(dir);
  store.close();
  const db = openAppStateDatabase(fs, dir, { createIfMissing: false });
  const indexes = (db.prepare('PRAGMA index_list(model_usage_records)').all() || [])
    .map((row) => String(row.name));
  assert.ok(indexes.includes('idx_model_usage_account_time'));
  db.close();
});
