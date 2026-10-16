'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeJsonValue, readJsonValue } = require('../lib/server/app-state-store');
const {
  buildWindowActivationConfigKey,
  buildWindowActivationStateKey,
  readWindowActivationConfig,
  writeWindowActivationConfig,
  readWindowActivationState,
  writeWindowActivationState,
  normalizeWindowActivationConfig,
  normalizeWindowActivationState
} = require('../lib/account/window-activation-store');

function createFixture(t, provider = 'codex') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-window-activation-store-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: '1',
    identitySeed: `oauth:${provider}:window-activation@example.com`
  });
  return { accountRef, aiHomeDir };
}

test('键名遵循 account:<feature>:<ref> 命名惯例', () => {
  const ref = 'acct_91aa805bdd051b40fa47';
  assert.equal(buildWindowActivationConfigKey(ref), `account:window-activation:${ref}`);
  assert.equal(buildWindowActivationStateKey(ref), `account:window-activation-state:${ref}`);
  assert.equal(buildWindowActivationConfigKey(''), '');
  assert.equal(buildWindowActivationConfigKey('not a ref'), '');
});

test('配置读写往返；未配置返回 null', (t) => {
  const { accountRef, aiHomeDir } = createFixture(t);
  assert.equal(readWindowActivationConfig(fs, aiHomeDir, accountRef), null);

  writeWindowActivationConfig(fs, aiHomeDir, accountRef, { enabled: true, intervalMs: 3600000 }, 1234);
  const stored = readWindowActivationConfig(fs, aiHomeDir, accountRef);
  assert.equal(stored.enabled, true);
  assert.equal(stored.intervalMs, 3600000);
  assert.equal(stored.updatedAt, 1234);
});

test('写入 null 等价于删除', (t) => {
  const { accountRef, aiHomeDir } = createFixture(t);
  writeWindowActivationConfig(fs, aiHomeDir, accountRef, { enabled: true, intervalMs: null });
  assert.ok(readWindowActivationConfig(fs, aiHomeDir, accountRef));
  writeWindowActivationConfig(fs, aiHomeDir, accountRef, null);
  assert.equal(readWindowActivationConfig(fs, aiHomeDir, accountRef), null);
});

test('intervalMs 非正数归一化为 null（跟随默认）', (t) => {
  const { accountRef, aiHomeDir } = createFixture(t);
  writeWindowActivationConfig(fs, aiHomeDir, accountRef, { enabled: true, intervalMs: 0 });
  assert.equal(readWindowActivationConfig(fs, aiHomeDir, accountRef).intervalMs, null);
});

test('不存在的账号写入被拒绝', (t) => {
  const { aiHomeDir } = createFixture(t);
  assert.throws(
    () => writeWindowActivationConfig(fs, aiHomeDir, 'acct_missing000000000000', { enabled: true }),
    /invalid_window_activation_account/
  );
});

test('损坏记录读取抛错，不伪装成未配置', (t) => {
  const { accountRef, aiHomeDir } = createFixture(t);
  writeJsonValue(fs, aiHomeDir, buildWindowActivationConfigKey(accountRef), ['not', 'an', 'object']);
  assert.throws(
    () => readWindowActivationConfig(fs, aiHomeDir, accountRef),
    /invalid_window_activation_config_record/
  );
});

test('状态读写往返（含「上次成功激活」与窗口账本）', (t) => {
  const { accountRef, aiHomeDir } = createFixture(t);
  assert.equal(readWindowActivationState(fs, aiHomeDir, accountRef), null);
  writeWindowActivationState(
    fs,
    aiHomeDir,
    accountRef,
    {
      lastProbeAt: 999,
      lastActivatedAt: 900,
      lastOutcome: 'activated',
      windowAnchorAtMs: 900,
      windowMinutes: 300,
      windowCloseAtMs: 900 + 300 * 60000,
      windowSource: 'probe',
      windowObservedAtMs: 900,
      probeFailureCount: 2,
      lastDecisionAction: 'skip',
      lastDecisionReason: 'window_open',
      lastDecisionAtMs: 901
    },
    1000
  );
  const state = readWindowActivationState(fs, aiHomeDir, accountRef);
  assert.equal(state.lastProbeAt, 999);
  assert.equal(state.lastActivatedAt, 900);
  assert.equal(state.lastOutcome, 'activated');
  assert.equal(state.windowAnchorAtMs, 900);
  assert.equal(state.windowMinutes, 300);
  assert.equal(state.windowCloseAtMs, 900 + 300 * 60000);
  assert.equal(state.windowSource, 'probe');
  assert.equal(state.probeFailureCount, 2);
  assert.equal(state.lastDecisionAction, 'skip');
  assert.equal(state.lastDecisionReason, 'window_open');
  assert.equal(state.lastDecisionAtMs, 901);
  assert.equal(state.updatedAt, 1000);
});

test('normalize 形状：坏输入返回 null 或安全默认', () => {
  assert.equal(normalizeWindowActivationConfig(null), null);
  assert.equal(normalizeWindowActivationConfig('x'), null);
  assert.deepEqual(normalizeWindowActivationConfig({ enabled: 1 }), { enabled: false, intervalMs: null, updatedAt: 0 });
  assert.deepEqual(
    normalizeWindowActivationState({ lastProbeAt: -5 }),
    {
      lastProbeAt: 0,
      lastActivatedAt: 0,
      lastOutcome: '',
      windowAnchorAtMs: 0,
      windowMinutes: 0,
      windowCloseAtMs: 0,
      windowSource: '',
      windowObservedAtMs: 0,
      probeFailureCount: 0,
      lastDecisionAction: '',
      lastDecisionReason: '',
      lastDecisionAtMs: 0,
      updatedAt: 0
    }
  );
  // 旧记录（没有 lastActivatedAt）按「还没成功激活过」读，下一轮会重试。
  assert.equal(normalizeWindowActivationState({ lastProbeAt: 5 }).lastActivatedAt, 0);
  // 旧记录（没有账本字段）等价于「窗口状态未知」→ 调度器退回兜底节奏，不会误判成有窗口。
  const legacy = normalizeWindowActivationState({ lastProbeAt: 5, lastActivatedAt: 6, lastOutcome: 'activated' });
  assert.equal(legacy.windowCloseAtMs, 0);
  assert.equal(legacy.windowObservedAtMs, 0);
  assert.equal(legacy.windowSource, '');
  // 坏字段一律读成「没有这条事实」，非法来源/判定动作被丢弃
  const dirty = normalizeWindowActivationState({
    windowAnchorAtMs: 'nope',
    windowMinutes: -1,
    windowCloseAtMs: {},
    windowSource: 'guess',
    windowObservedAtMs: NaN,
    probeFailureCount: -3,
    lastDecisionAction: 'explode',
    lastDecisionAtMs: Infinity
  });
  assert.equal(dirty.windowAnchorAtMs, 0);
  assert.equal(dirty.windowMinutes, 0);
  assert.equal(dirty.windowCloseAtMs, 0);
  assert.equal(dirty.windowSource, '');
  assert.equal(dirty.windowObservedAtMs, 0);
  assert.equal(dirty.probeFailureCount, 0);
  assert.equal(dirty.lastDecisionAction, '');
  assert.equal(dirty.lastDecisionAtMs, 0);
});

test('写入的记录是合法 JSON 且可被 app_kv 读回', (t) => {
  const { accountRef, aiHomeDir } = createFixture(t);
  writeWindowActivationConfig(fs, aiHomeDir, accountRef, { enabled: true, intervalMs: null });
  const raw = readJsonValue(fs, aiHomeDir, buildWindowActivationConfigKey(accountRef), { strict: true });
  assert.equal(raw.enabled, true);
  assert.equal(raw.intervalMs, null);
});
