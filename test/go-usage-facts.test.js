'use strict';

// Node 快照 → Go 额度事实的映射口径。
// 这些断言锁住三件事：账号级窗口用 account scope、模型级额度用 model_family（不误伤整号）、
// 空快照写入 unknown 条目以清掉 Go 里的旧事实。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUsageFacts } = require('../lib/account/go-bridge/go-usage-facts');

test('codex windows map to account-scoped entries', () => {
  const facts = buildUsageFacts({
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_read_rate_limits',
    capturedAt: 1762300000000,
    entries: [
      { bucket: 'primary', label: '5h', remainingPct: 42.5, windowMinutes: 300, resetAtMs: 1762303000000 },
      { bucket: 'secondary', label: '7days', remainingPct: 0, windowMinutes: 10080, resetAtMs: 1762900000000 }
    ]
  });
  assert.equal(facts.source, 'codex_read_rate_limits');
  assert.equal(facts.captured_at, '1762300000000');
  assert.equal(facts.entries.length, 2);

  const primary = facts.entries.find((entry) => entry.bucket === 'primary');
  assert.equal(primary.scope, 'account');
  assert.equal(primary.scope_key, '');
  assert.equal(primary.kind, 'window');
  assert.equal(primary.remaining_basis_points, 4250);
  assert.equal(primary.window_seconds, 18000);
  assert.equal(primary.reset_at, '1762303000000');
  assert.equal(primary.availability, 'available');

  const secondary = facts.entries.find((entry) => entry.bucket === 'secondary');
  assert.equal(secondary.remaining_basis_points, 0);
  assert.equal(secondary.availability, 'exhausted');
});

test('model quotas map to model_family and never block the account', () => {
  const facts = buildUsageFacts({
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: 1762300000000,
    models: [
      { model: 'gemini-2.5-pro', remainingPct: 0 },
      { model: 'gemini-2.5-flash', remainingPct: 80 }
    ]
  });
  assert.equal(facts.entries.length, 2);
  for (const entry of facts.entries) {
    assert.equal(entry.scope, 'model_family');
    assert.notEqual(entry.scope_key, '');
  }
  const pro = facts.entries.find((entry) => entry.scope_key === 'gemini-2.5-pro');
  assert.equal(pro.availability, 'exhausted');
  assert.equal(pro.bucket, 'gemini-2.5-pro');
});

test('gift and detail scopes never reach the account-level facts', () => {
  const facts = buildUsageFacts({
    schemaVersion: 2,
    kind: 'kimi_oauth_usage',
    source: 'kimi_usage_api',
    capturedAt: 1762300000000,
    entries: [
      { bucket: 'monthly', remainingPct: 55 },
      { bucket: 'gift:Invite to Earn Credit', remainingPct: 0, category: 'gift' }
    ]
  });
  assert.equal(facts.entries.length, 1);
  assert.equal(facts.entries[0].bucket, 'monthly');
  assert.equal(facts.entries[0].availability, 'available');
});

test('a snapshot without renderable quota still clears Go facts', () => {
  const facts = buildUsageFacts({
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_account_read',
    capturedAt: 1762300000000,
    entries: []
  });
  assert.equal(facts.entries.length, 1);
  assert.equal(facts.entries[0].bucket, 'usage_unknown');
  assert.equal(facts.entries[0].availability, 'unknown');
  assert.equal(facts.entries[0].has_remaining, false);
});

test('snapshots without a usable capture time or source are not facts', () => {
  assert.equal(buildUsageFacts(null), null);
  assert.equal(buildUsageFacts({ kind: 'codex_oauth_status', source: 'x', capturedAt: 0 }), null);
  assert.equal(buildUsageFacts({ kind: 'codex_oauth_status', capturedAt: 1000 }), null);
});
