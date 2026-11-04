'use strict';

// Go 物化的账号额度状态是 Node 服务端与 CLI 的共同读入口。
// 这里锁住读取形状与「旧库没有列时安全回退」，避免 CLI 在迁移窗口里崩掉。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { readGoQuotaStates } = require('../lib/account/go-bridge/go-account-store-reader');
const { deriveQuotaState } = require('../lib/account/derived-state');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-quota-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createDb(dir, options = {}) {
  const db = new DatabaseSync(path.join(dir, 'aih.db'));
  db.exec(`CREATE TABLE account_usage_snapshots (
    account_ref TEXT PRIMARY KEY,
    captured_at_ms INTEGER NOT NULL DEFAULT 0
    ${options.withState ? `,
    quota_status TEXT NOT NULL DEFAULT '',
    quota_reason TEXT NOT NULL DEFAULT '',
    remaining_bps INTEGER,
    has_numeric_remaining INTEGER NOT NULL DEFAULT 0` : ''}
  )`);
  return db;
}

test('persisted quota states are exposed with pct and capture time', (t) => {
  const dir = tmp(t);
  const db = createDb(dir, { withState: true });
  db.prepare(`INSERT INTO account_usage_snapshots
    (account_ref, captured_at_ms, quota_status, quota_reason, remaining_bps, has_numeric_remaining)
    VALUES (?, ?, ?, ?, ?, ?)`).run('acct_aaaaaaaaaaaaaaaaaaaa', 1793800000000, 'pending', 'codex_team_plan_pending_rate_limits', null, 0);
  db.prepare(`INSERT INTO account_usage_snapshots
    (account_ref, captured_at_ms, quota_status, quota_reason, remaining_bps, has_numeric_remaining)
    VALUES (?, ?, ?, ?, ?, ?)`).run('acct_bbbbbbbbbbbbbbbbbbbb', 1793800000001, 'available', '', 4250, 1);
  db.prepare(`INSERT INTO account_usage_snapshots
    (account_ref, captured_at_ms, quota_status, quota_reason)
    VALUES (?, ?, ?, ?)`).run('acct_cccccccccccccccccccc', 1, '', '');
  db.close();

  const { exists, states } = readGoQuotaStates(dir);
  assert.equal(exists, true);
  assert.equal(states.size, 2, 'rows without a derived state are skipped');
  assert.deepEqual(states.get('acct_aaaaaaaaaaaaaaaaaaaa'), {
    status: 'pending',
    reason: 'codex_team_plan_pending_rate_limits',
    remainingPct: null,
    hasNumericRemaining: false,
    capturedAtMs: 1793800000000
  });
  assert.equal(states.get('acct_bbbbbbbbbbbbbbbbbbbb').remainingPct, 42.5);
  assert.equal(states.get('acct_bbbbbbbbbbbbbbbbbbbb').hasNumericRemaining, true);
});

test('a pre-v12 database without the state columns falls back safely', (t) => {
  const dir = tmp(t);
  const db = createDb(dir, { withState: false });
  db.prepare('INSERT INTO account_usage_snapshots (account_ref, captured_at_ms) VALUES (?, ?)')
    .run('acct_aaaaaaaaaaaaaaaaaaaa', 1);
  db.close();

  const { exists, states } = readGoQuotaStates(dir);
  assert.equal(exists, true);
  assert.equal(states.size, 0);
});

test('a missing database reads as empty', (t) => {
  const dir = tmp(t);
  const { exists, states } = readGoQuotaStates(dir);
  assert.equal(exists, false);
  assert.equal(states.size, 0);
});

test('Node no longer derives codex team/free pending reasons', () => {
  // Go 的 DeriveQuotaState 是这两个原因的唯一实现；Node 的本地推导只保留通用结论。
  for (const planType of ['team', 'free']) {
    const state = deriveQuotaState({
      provider: 'codex',
      configured: true,
      apiKeyMode: false,
      planType,
      usageSnapshot: {
        kind: 'codex_oauth_status',
        source: 'codex_account_read',
        fallbackSource: 'account_read',
        capturedAt: 1,
        entries: []
      }
    });
    assert.equal(state.status, 'pending');
    assert.equal(state.reason, 'provider_returned_no_numeric_usage');
  }
});
