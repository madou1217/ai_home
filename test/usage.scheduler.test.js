const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scheduler = require('../lib/usage/scheduler.js');
const thresholdSwitch = require('../lib/usage/threshold-switch.js');
const permissionPolicy = require('../lib/runtime/permission-policy.js');

test('usage scheduler exports deterministic interval constants and API', () => {
  assert.equal(scheduler.ONE_MINUTE_MS, 60 * 1000);
  assert.equal(scheduler.THREE_MINUTES_MS, 3 * 60 * 1000);
  assert.equal(scheduler.ONE_HOUR_MS, 60 * 60 * 1000);
  assert.equal(typeof scheduler.normalizeConfig, 'function');
  assert.equal(typeof scheduler.createUsageScheduler, 'function');
});

test('usage scheduler normalizeConfig uses safe defaults for invalid values', () => {
  const normalized = scheduler.normalizeConfig({
    activeRefreshIntervalMs: 12345,
    backgroundRefreshIntervalMs: -1
  });
  assert.deepEqual(normalized, {
    activeRefreshIntervalMs: scheduler.ONE_MINUTE_MS,
    backgroundRefreshIntervalMs: scheduler.ONE_HOUR_MS
  });
});

test('threshold switch exports stable configuration constants', () => {
  assert.equal(typeof thresholdSwitch.DEFAULT_THRESHOLD_PCT, 'number');
  assert.equal(typeof thresholdSwitch.MIN_THRESHOLD_PCT, 'number');
  assert.equal(typeof thresholdSwitch.MAX_THRESHOLD_PCT, 'number');
  assert.equal(typeof thresholdSwitch.normalizeThresholdPct, 'function');
  assert.equal(typeof thresholdSwitch.normalizeUsagePct, 'function');
  assert.equal(typeof thresholdSwitch.evaluateThresholdSwitch, 'function');
});

test('threshold switch selects the best eligible account when threshold is crossed', () => {
  const result = thresholdSwitch.evaluateThresholdSwitch({
    currentAccountId: 'acct-a',
    currentUsagePct: 95,
    thresholdPct: 90,
    accounts: [
      { accountId: 'acct-a', usagePct: 95, available: true, exhausted: false },
      { accountId: 'acct-b', usagePct: 50, available: true, exhausted: false },
      { accountId: 'acct-c', usagePct: 30, available: true, exhausted: false }
    ]
  });

  assert.equal(result.shouldSwitch, true);
  assert.equal(result.reason, 'threshold_crossed');
  assert.equal(result.toAccountId, 'acct-c');
});

test('threshold switch remains on current account when usage is below threshold', () => {
  const result = thresholdSwitch.evaluateThresholdSwitch({
    currentAccountId: 'acct-a',
    currentUsagePct: 40,
    thresholdPct: 90,
    accounts: [
      { accountId: 'acct-a', usagePct: 40, available: true, exhausted: false },
      { accountId: 'acct-b', usagePct: 20, available: true, exhausted: false }
    ]
  });

  assert.equal(result.shouldSwitch, false);
  assert.equal(result.reason, 'below_threshold');
  assert.equal(result.toAccountId, '');
});

test('permission policy module exports stable API contract', () => {
  assert.equal(typeof permissionPolicy.POLICY_VERSION, 'number');
  assert.equal(typeof permissionPolicy.DEFAULT_POLICY, 'object');
  assert.equal(typeof permissionPolicy.resolvePolicyPath, 'function');
  assert.equal(typeof permissionPolicy.normalizePolicy, 'function');
  assert.equal(typeof permissionPolicy.loadPermissionPolicy, 'function');
  assert.equal(typeof permissionPolicy.savePermissionPolicy, 'function');
  assert.equal(typeof permissionPolicy.shouldUseDangerFullAccess, 'function');
});

test('permission policy persists and reloads full-access preference deterministically', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-policy-'));
  const policyFile = path.join(tempDir, 'exec-permission-policy.json');
  const saved = permissionPolicy.savePermissionPolicy({
    exec: {
      defaultSandbox: 'danger-full-access',
      allowDangerFullAccess: true
    }
  }, { policyFile });

  assert.equal(saved.exec.defaultSandbox, 'danger-full-access');
  assert.equal(saved.exec.allowDangerFullAccess, true);
  assert.equal(typeof saved.updatedAt, 'string');
  assert.equal(saved.updatedAt.length > 0, true);

  const loaded = permissionPolicy.loadPermissionPolicy({ policyFile });
  assert.equal(loaded.exec.defaultSandbox, 'danger-full-access');
  assert.equal(loaded.exec.allowDangerFullAccess, true);
  assert.equal(permissionPolicy.shouldUseDangerFullAccess(loaded), true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
