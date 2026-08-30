'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const { listAccountQuotaResetEvents } = require('../lib/account/quota-reset-store');
const { handleWebUiAccountQuotaResetRoutes } = require('../lib/server/webui-account-quota-reset-routes');
const { createAccountQuotaProbeScheduler } = require('../lib/server/account-quota-probe-scheduler');

function createMockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      return this;
    },
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
      this.writableEnded = true;
      return this;
    }
  };
  return res;
}

test('quota reset detector captures cycle rollover and early replenishment events with physical occurredAtMs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-reset-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:user@example.com'
  });

  const now = 1787500000000;
  const cycle1ResetAt = now + 5 * 3600 * 1000; // 5 hours later

  // 1. Initial snapshot: 10% remaining (baseline)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now,
    source: 'codex_app_server',
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 10.0,
        resetAtMs: cycle1ResetAt
      }
    ]
  });

  let events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 0, 'Baseline snapshot should not generate events');

  // 2. Early replenishment: still within cycle 1 (now + 1h), but quota suddenly jumps to 100%
  const earlyTime = now + 3600 * 1000;
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: earlyTime,
    source: 'codex_app_server',
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 100.0,
        resetAtMs: cycle1ResetAt
      }
    ]
  });

  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1, 'Early replenishment should trigger 1 event');
  assert.equal(events[0].eventKind, 'replenishment');
  assert.equal(events[0].classification, 'early_inferred');
  assert.equal(events[0].previousRemainingPct, 10.0);
  assert.equal(events[0].currentRemainingPct, 100.0);
  assert.equal(events[0].occurredAtMs, earlyTime);
  assert.ok(events[0].earlyDurationMs > 0, 'Should record early duration');

  // 3. Repeated snapshot at 100%: should be idempotent and not create duplicate events
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: earlyTime + 60000,
    source: 'codex_app_server',
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 100.0,
        resetAtMs: cycle1ResetAt
      }
    ]
  });
  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1, 'Duplicate 100% snapshot should be idempotent');

  // 4. Usage drops to 0% at 18:00 (now + 2h)
  const exhaustedTime = earlyTime + 3600 * 1000;
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: exhaustedTime,
    source: 'codex_app_server',
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 0.0,
        resetAtMs: cycle1ResetAt
      }
    ]
  });

  // 5. Natural cycle rollover: scheduled reset is cycle1ResetAt (23:00).
  // User observes/probes 1 hour later (24:00 = cycle1ResetAt + 3600*1000)
  const probeAtMidnight = cycle1ResetAt + 3600 * 1000;
  const cycle2ResetAt = cycle1ResetAt + 5 * 3600 * 1000;

  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: probeAtMidnight,
    source: 'codex_app_server',
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 100.0,
        resetAtMs: cycle2ResetAt
      }
    ]
  });

  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 2, 'Cycle rollover should trigger second event');
  assert.equal(events[0].eventKind, 'cycle_rollover');
  assert.equal(events[0].classification, 'natural');
  assert.equal(events[0].previousRemainingPct, 0.0);
  assert.equal(events[0].currentRemainingPct, 100.0);
  // Crucial check: physical occurredAtMs is exactly the scheduled reset time (23:00), not the late probe time (24:00)
  assert.equal(events[0].occurredAtMs, cycle1ResetAt);
  assert.equal(events[0].detectedAtMs, probeAtMidnight);
  assert.equal(events[0].exhaustedAtMs, exhaustedTime);

  fs.rmSync(root, { recursive: true, force: true });
});

test('webui account quota reset routes return event history with pagination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-route-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '1',
    identitySeed: 'oauth:claude:user@example.com'
  });

  const now = Date.now();
  // Baseline
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    kind: 'claude_oauth_usage',
    capturedAt: now - 3600000,
    entries: [{ bucket: 'five_hour', window: '5h', remainingPct: 20.0, resetAtMs: now + 3600000 }]
  });

  // Early reset
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    kind: 'claude_oauth_usage',
    capturedAt: now,
    entries: [{ bucket: 'five_hour', window: '5h', remainingPct: 100.0, resetAtMs: now + 3600000 }]
  });

  const res = createMockResponse();
  const ctx = {
    res,
    method: 'GET',
    pathname: `/v0/webui/accounts/claude/${accountRef}/quota-reset-events`,
    url: new URL(`http://127.0.0.1/v0/webui/accounts/claude/${accountRef}/quota-reset-events`),
    fs,
    aiHomeDir,
    writeJson(resObj, status, payload) {
      const target = resObj || res;
      target.statusCode = status;
      target.body = JSON.stringify(payload);
    }
  };

  const handled = await handleWebUiAccountQuotaResetRoutes(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.accountRef, accountRef);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].classification, 'early_inferred');

  fs.rmSync(root, { recursive: true, force: true });
});

test('quota probe scheduler triggers auto probe for accounts near reset time', async () => {
  const probedAccounts = [];
  const fakeEnsureUsageSnapshotAsync = async (provider, accountRef, snapshot, opts) => {
    probedAccounts.push({ provider, accountRef, forceRefresh: opts?.forceRefresh });
    return snapshot;
  };

  const now = Date.now();
  const testAccount = {
    provider: 'codex',
    accountRef: 'acct_scheduler_test',
    apiKeyMode: false,
    usageSnapshot: {
      capturedAt: now - 3600000,
      entries: [
        {
          bucket: 'primary',
          remainingPct: 0.0,
          resetAtMs: now + 60000 // resets in 1 minute
        }
      ]
    }
  };

  const scheduler = createAccountQuotaProbeScheduler({
    ensureUsageSnapshotAsync: fakeEnsureUsageSnapshotAsync,
    listAccounts: () => [testAccount]
  }, { quotaProbeIntervalMs: 1000 });

  await scheduler.tick();
  assert.equal(probedAccounts.length, 1);
  assert.equal(probedAccounts[0].accountRef, 'acct_scheduler_test');
  assert.equal(probedAccounts[0].forceRefresh, true);
});

test('quota reset detector strictly rejects consumption (e.g. 100% -> 42%) and no-op 100% -> 100% as reset events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-strict-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:strict@example.com'
  });

  const now = 1787500000000;
  const cycleResetAt = now + 5 * 3600 * 1000;

  // 1. Initial 100%
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now,
    entries: [{ bucket: 'primary', remainingPct: 100.0, resetAtMs: cycleResetAt }]
  });

  // 2. Consumption: drops from 100% to 42% (even if resetAtMs changed/advanced). MUST NOT BE A RESET!
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now + 3600 * 1000,
    entries: [{ bucket: 'primary', remainingPct: 42.0, resetAtMs: cycleResetAt + 3600 * 1000 }]
  });

  let events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 0, 'Consumption from 100% to 42% must NOT create a reset event');

  // 3. Further consumption: 42% to 30%
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now + 2 * 3600 * 1000,
    entries: [{ bucket: 'primary', remainingPct: 30.0, resetAtMs: cycleResetAt + 3600 * 1000 }]
  });
  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 0, 'Further drop must NOT create a reset event');

  // 4. Recovery / Reset: rises from 30% to 99% or 100% (even 1% consumed like 99% -> 100%)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now + 3 * 3600 * 1000,
    entries: [{ bucket: 'primary', remainingPct: 100.0, resetAtMs: cycleResetAt + 3600 * 1000 }]
  });

  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1, 'Upward jump from 30% to 100% MUST create a reset event');
  assert.equal(events[0].previousRemainingPct, 30.0);
  assert.equal(events[0].currentRemainingPct, 100.0);

  // 5. Minor consumption (100% -> 99%) followed by recovery (99% -> 100%)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now + 4 * 3600 * 1000,
    entries: [{ bucket: 'primary', remainingPct: 99.0, resetAtMs: cycleResetAt + 3600 * 1000 }]
  });
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now + 5 * 3600 * 1000,
    entries: [{ bucket: 'primary', remainingPct: 100.0, resetAtMs: cycleResetAt + 3600 * 1000 }]
  });
  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 2, 'Recovery from 99% to 100% MUST also be recorded as a reset event');
  assert.equal(events[0].previousRemainingPct, 99.0);
  assert.equal(events[0].currentRemainingPct, 100.0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('quota reset detector recognizes plan upgrade (e.g. Free -> Plus) and sets classification to plan_upgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-upgrade-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:upgrade@example.com'
  });

  const now = 1787500000000;
  // 1. Free plan with 2% remaining, reset far in future (e.g. 15 days)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    capturedAt: now,
    account: { planType: 'free', email: 'upgrade@example.com' },
    entries: [{ bucket: 'primary', remainingPct: 2.0, resetAtMs: now + 15 * 86400000 }]
  });

  let events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 0);

  // 2. Upgraded to Plus plan: quota jumps to 100%, reset moves to 5h
  const upgradeTime = now + 1800 * 1000;
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    capturedAt: upgradeTime,
    account: { planType: 'plus', email: 'upgrade@example.com' },
    entries: [{ bucket: 'primary', remainingPct: 100.0, resetAtMs: upgradeTime + 5 * 3600000 }]
  });

  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventKind, 'replenishment');
  assert.equal(events[0].classification, 'plan_upgrade');
  assert.equal(events[0].cause, 'upgrade:free->plus');
  assert.equal(events[0].previousPlanType, 'free');
  assert.equal(events[0].currentPlanType, 'plus');
  assert.equal(events[0].previousRemainingPct, 2.0);
  assert.equal(events[0].currentRemainingPct, 100.0);
  assert.equal(events[0].earlyDurationMs, 0, 'Plan upgrade should not report absurd earlyDuration');

  fs.rmSync(root, { recursive: true, force: true });
});

test('quota reset detector strictly ignores login/auth methods like "oauth" or "api-key" as plan types', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-oauth-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:test@example.com'
  });

  const now = 1787500000000;
  // 1. Initial snapshot with planType 'oauth' (fallback string) and 80.36% remaining
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    capturedAt: now,
    account: { planType: 'oauth', email: 'test@example.com' },
    models: [
      {
        model: 'gemini-3.5-flash',
        remainingPct: 80.36,
        resetIn: '5h',
        resetAtMs: now + 5 * 3600000
      }
    ]
  });

  // 2. Snapshot later where upstream returns subscriptionTier 'Google AI Pro' -> planType 'pro', but quota is still 80.36% (no reset happened)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    capturedAt: now + 60000,
    account: { planType: 'pro', subscriptionTier: 'Google AI Pro', email: 'test@example.com' },
    models: [
      {
        model: 'gemini-3.5-flash',
        remainingPct: 80.36,
        resetIn: '5h',
        resetAtMs: now + 5 * 3600000
      }
    ]
  });

  let events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 0, 'Switching from fallback "oauth" to detected "pro" with unchanged quota MUST NOT trigger fake plan upgrade reset');

  // 3. True upgrade: quota replenished from 80.36% to 100% on Pro -> Ultra upgrade
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    capturedAt: now + 120000,
    account: { planType: 'ultra', subscriptionTier: 'Google AI Ultra', email: 'test@example.com' },
    models: [
      {
        model: 'gemini-3.5-flash',
        remainingPct: 100.0,
        resetIn: '5h',
        resetAtMs: now + 120000 + 5 * 3600000
      }
    ]
  });

  events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1, 'Pro -> Ultra upgrade with full quota replenishment must record 1 plan_upgrade event');
  assert.equal(events[0].classification, 'plan_upgrade');
  assert.equal(events[0].previousPlanType, 'pro');
  assert.equal(events[0].currentPlanType, 'ultra');
  assert.equal(events[0].previousRemainingPct, 80.36);
  assert.equal(events[0].currentRemainingPct, 100.0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('quota reset detector delegates observation and tier ranking to provider-specific strategies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-strategy-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '1',
    identitySeed: 'oauth:claude:tier@example.com'
  });

  const now = 1787500000000;
  // Claude Free -> Pro
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'claude_oauth_usage',
    capturedAt: now,
    account: { planType: 'free', email: 'tier@example.com' },
    entries: [{ bucket: 'five_hour', remainingPct: 15.0, resetAtMs: now + 5 * 3600000 }]
  });
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'claude_oauth_usage',
    capturedAt: now + 10000,
    account: { planType: 'pro', email: 'tier@example.com' },
    entries: [{ bucket: 'five_hour', remainingPct: 100.0, resetAtMs: now + 5 * 3600000 }]
  });

  const events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1);
  assert.equal(events[0].classification, 'plan_upgrade');
  assert.equal(events[0].previousPlanType, 'free');
  assert.equal(events[0].currentPlanType, 'pro');

  fs.rmSync(root, { recursive: true, force: true });
});
