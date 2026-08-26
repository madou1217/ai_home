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

test('quota reset detector captures cycle rollover and early replenishment events', () => {
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

  // 4. Usage drops to 50%, then natural cycle rollover happens
  const cycleRolloverTime = cycle1ResetAt + 10000;
  const cycle2ResetAt = cycleRolloverTime + 5 * 3600 * 1000;

  // Usage drop
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: earlyTime + 2 * 3600 * 1000,
    source: 'codex_app_server',
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 50.0,
        resetAtMs: cycle1ResetAt
      }
    ]
  });

  // Cycle rollover (resetAtMs jumps to cycle 2)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: cycleRolloverTime,
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
  assert.equal(events[0].previousRemainingPct, 50.0);
  assert.equal(events[0].currentRemainingPct, 100.0);

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

test('quota reset detector captures exhaustedAtMs when quota reaches 0%', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-exhausted-test-'));
  const aiHomeDir = path.join(root, '.ai_home');

  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:exhausted@example.com'
  });

  const now = 1787500000000;
  const cycleResetAt = now + 5 * 3600 * 1000;

  // 1. Quota drops to 0% at now (exhausted)
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: now,
    entries: [{ bucket: 'primary', window: '5h', remainingPct: 0.0, resetAtMs: cycleResetAt }]
  });

  // 2. Early reset 2 hours later
  const resetTime = now + 2 * 3600 * 1000;
  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: resetTime,
    entries: [{ bucket: 'primary', window: '5h', remainingPct: 100.0, resetAtMs: cycleResetAt }]
  });

  const events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef);
  assert.equal(events.length, 1);
  assert.equal(events[0].exhaustedAtMs, now);
  assert.equal(events[0].detectedAtMs, resetTime);

  fs.rmSync(root, { recursive: true, force: true });
});
