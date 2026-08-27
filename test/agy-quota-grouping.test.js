const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const { listAccountQuotaResetEvents } = require('../lib/account/quota-reset-store');

test('AGY quota resets are grouped into Gemini Models and Claude/GPT Models instead of per-model spam', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-group-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:user@example.com'
  });

  const now = 1787500000000;
  const resetAt = now + 5 * 3600 * 1000;

  // Snapshot with 24 individual models (21 gemini models + 3 claude/gpt models)
  const models = [
    { model: 'claude-opus-4-6-thinking', remainingPct: 70.0, resetAtMs: resetAt },
    { model: 'claude-sonnet-4-6', remainingPct: 70.0, resetAtMs: resetAt },
    { model: 'gpt-oss-120b-medium', remainingPct: 70.0, resetAtMs: resetAt },
    { model: 'gemini-2.5-flash', remainingPct: 80.0, resetAtMs: resetAt },
    { model: 'gemini-2.5-pro', remainingPct: 80.0, resetAtMs: resetAt },
    { model: 'gemini-3-flash', remainingPct: 80.0, resetAtMs: resetAt },
    { model: 'gemini-3.7-flash-high', remainingPct: 80.0, resetAtMs: resetAt }
  ];

  // 1. Initial snapshot with consumed quota
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    capturedAt: now,
    models
  });

  let events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 0);

  // 2. Replenished snapshot
  const replenishedModels = models.map(m => ({ ...m, remainingPct: 100.0 }));
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    capturedAt: now + 3600 * 1000,
    models: replenishedModels
  });

  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  // Must generate exactly 2 grouped events (1 for Claude & GPT Models, 1 for Gemini Models), NOT 7 or 24 individual spam events!
  assert.equal(events.length, 2, 'Should generate exactly 2 grouped events for AGY pools');
  const labels = events.map(e => e.windowLabel);
  assert.ok(labels.includes('Claude & GPT 模型池'));
  assert.ok(labels.includes('Gemini 模型池'));

  fs.rmSync(root, { recursive: true, force: true });
});
