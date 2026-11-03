'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_COOLDOWN_MS,
  createAutoSwitchPolicy,
  detectRateLimitSignal,
  formatCooldownLabel,
  readRelativeResetMs
} = require('../lib/cli/services/pty/auto-switch-policy');
const { normalizeConfig, DEFAULTS } = require('../lib/usage/config-store');

// 2026-10-31 14:57:00 UTC+8 = 06:57:00Z
const CODEBUDDY_429 = 'API Error: 429 usage exceeds frequency limit, please try again later. '
  + 'your usage will reset at 2026-10-31 14:57:00 UTC+8';
const CODEBUDDY_RESET_MS = Date.UTC(2026, 9, 31, 6, 57, 0);
const BEFORE_RESET_MS = Date.UTC(2026, 9, 31, 5, 0, 0);

test('codebuddy 429 with an absolute reset time is a switch signal', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_429, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.kind, 'rate_limit');
  assert.equal(signal.signature, 'codebuddy-frequency-window');
  assert.equal(signal.resetAtMs, CODEBUDDY_RESET_MS);
});

test('429 without a recovery time is not a switch signal', () => {
  assert.equal(detectRateLimitSignal('API Error: 429 Too Many Requests', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(detectRateLimitSignal('rate limit exceeded', { nowMs: BEFORE_RESET_MS }), null);
});

test('a reset time that already passed is history, not a signal', () => {
  assert.equal(detectRateLimitSignal(CODEBUDDY_429, { nowMs: CODEBUDDY_RESET_MS + 60_000 }), null);
});

test('relative retry hints are converted to an absolute deadline', () => {
  assert.equal(readRelativeResetMs('try again in 90 seconds'), 90_000);
  assert.equal(readRelativeResetMs('Please retry after 5 minutes'), 300_000);
  assert.equal(readRelativeResetMs('available again in 2 hours'), 7_200_000);
  assert.equal(readRelativeResetMs('try again later'), 0);
  const signal = detectRateLimitSignal('429 RESOURCE_EXHAUSTED, try again in 10 minutes', { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, BEFORE_RESET_MS + 600_000);
});

test('the detector ignores ordinary prose that merely mentions rate limiting', () => {
  assert.equal(detectRateLimitSignal('为什么我会看到 rate limit 和 429 错误？', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(detectRateLimitSignal('quota policy discussion', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(detectRateLimitSignal('', { nowMs: BEFORE_RESET_MS }), null);
});

test('detection survives TUI line wrapping inside the message', () => {
  const wrapped = 'API Error: 429 usage exceeds frequency limit\n  your usage will reset at\n  2026-10-31 14:57:00 UTC+8';
  const signal = detectRateLimitSignal(wrapped, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, CODEBUDDY_RESET_MS);
});

test('a far-future hint is clamped to the 24h cooldown ceiling', () => {
  const signal = detectRateLimitSignal('429 quota exceeded, try again in 30 days', { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, BEFORE_RESET_MS + MAX_COOLDOWN_MS);
});

test('config: the mode is off by default and the threshold follows threshold_pct', () => {
  assert.equal(DEFAULTS.auto_switch, false);
  assert.equal(DEFAULTS.auto_switch_remaining_pct, null);
  const policy = createAutoSwitchPolicy({ readConfig: () => ({ ...DEFAULTS }) });
  assert.equal(policy.isEnabled(), false);
  assert.equal(policy.readSettings().remainingPct, 5);
  assert.equal(policy.evaluateUsage(0).switch, false);
});

test('config: enabling switches only at or below the configured threshold', () => {
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: 0 })
  });
  assert.equal(policy.isEnabled(), true);
  assert.equal(policy.evaluateUsage(0.4).switch, false);
  assert.equal(policy.evaluateUsage(0).switch, true);
  assert.match(policy.evaluateUsage(0).reason, /额度剩余 0%/);

  const followThreshold = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: null, threshold_pct: 80 })
  });
  assert.equal(followThreshold.readSettings().remainingPct, 20);
  assert.equal(followThreshold.evaluateUsage(21).switch, false);
  assert.equal(followThreshold.evaluateUsage(20).switch, true);
});

test('config: AIH_RUNTIME_USAGE auto_switch overrides the stored config per session', () => {
  const onViaEnv = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: false }),
    readEnvField: (key) => (key === 'auto_switch' ? '1' : '')
  });
  assert.equal(onViaEnv.isEnabled(), true);
  const offViaEnv = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    readEnvField: (key) => (key === 'auto_switch' ? '0' : '')
  });
  assert.equal(offViaEnv.isEnabled(), false);
});

test('config: the threshold can be overridden per session', () => {
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: 0 }),
    readEnvField: (key) => (key === 'auto_switch_remaining' ? '100' : '')
  });
  assert.equal(policy.readSettings().remainingPct, 100);
  assert.equal(policy.evaluateUsage(100).switch, true);
  const junk = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: 0 }),
    readEnvField: (key) => (key === 'auto_switch_remaining' ? 'abc' : '')
  });
  assert.equal(junk.readSettings().remainingPct, 0);
});

test('cooldown is keyed by (account, model) and expires on its own', () => {
  let nowMs = BEFORE_RESET_MS;
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    now: () => nowMs
  });
  const recorded = policy.noteRateLimit({ accountRef: 'acct_a', model: 'deepseek', resetAtMs: CODEBUDDY_RESET_MS });
  assert.equal(recorded.untilMs, CODEBUDDY_RESET_MS);
  assert.equal(policy.isCooling('acct_a', 'deepseek'), true);
  assert.equal(policy.isCooling('acct_a', 'glm-5'), false);
  assert.equal(policy.isCooling('acct_b', 'deepseek'), false);
  assert.deepEqual(policy.coolingAccountRefs(), ['acct_a']);
  assert.equal(policy.describeCooldown('acct_a', 'deepseek'), formatCooldownLabel(CODEBUDDY_RESET_MS, nowMs));

  nowMs = CODEBUDDY_RESET_MS + 1000;
  assert.equal(policy.isCooling('acct_a', 'deepseek'), false);
  assert.deepEqual(policy.coolingAccountRefs(), []);
});

test('an unknown model is treated as account-wide (conservative)', () => {
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    now: () => BEFORE_RESET_MS
  });
  policy.noteRateLimit({ accountRef: 'acct_a', model: 'deepseek', resetAtMs: CODEBUDDY_RESET_MS });
  assert.equal(policy.isCooling('acct_a', ''), true);
});

test('a cooldown never extends past the 24h ceiling and never goes backwards', () => {
  const nowMs = BEFORE_RESET_MS;
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    now: () => nowMs
  });
  const far = policy.noteRateLimit({ accountRef: 'acct_a', model: 'm', resetAtMs: nowMs + 30 * 86400000 });
  assert.equal(far.untilMs, nowMs + MAX_COOLDOWN_MS);
  const sooner = policy.noteRateLimit({ accountRef: 'acct_a', model: 'm', resetAtMs: nowMs + 60_000 });
  assert.equal(sooner.untilMs, nowMs + MAX_COOLDOWN_MS);
  assert.equal(policy.noteRateLimit({ accountRef: 'acct_a', model: 'm', resetAtMs: nowMs - 1 }), null);
  assert.equal(policy.noteRateLimit({ accountRef: '', model: 'm', resetAtMs: nowMs + 60_000 }), null);
});

test('config-store round-trips the two new fields and rejects junk', () => {
  const enabled = normalizeConfig({ auto_switch: 'on', auto_switch_remaining_pct: '0' });
  assert.equal(enabled.auto_switch, true);
  assert.equal(enabled.auto_switch_remaining_pct, 0);

  const disabled = normalizeConfig({ auto_switch: 'maybe', auto_switch_remaining_pct: 'abc' });
  assert.equal(disabled.auto_switch, false);
  assert.equal(disabled.auto_switch_remaining_pct, null);

  assert.equal(normalizeConfig({ auto_switch_remaining_pct: 250 }).auto_switch_remaining_pct, 100);
  assert.equal(normalizeConfig({ auto_switch_remaining_pct: -3 }).auto_switch_remaining_pct, 0);
  // 老配置（没有这两个键）读出来仍然是「关闭 + 跟随 threshold_pct」。
  const legacy = normalizeConfig({ threshold_pct: 90 });
  assert.equal(legacy.auto_switch, false);
  assert.equal(legacy.auto_switch_remaining_pct, null);
});
