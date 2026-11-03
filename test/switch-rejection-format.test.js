'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatRejectionSummary } = require('../lib/cli/services/pty/switch-rejection-format');
const { createUsageStatusRuntime } = require('../lib/cli/services/pty/usage-status-runtime');

test('拒绝原因机器码 → 人话（带计数）', () => {
  assert.equal(
    formatRejectionSummary('runtime:rate_limited=2, quota_exhausted=1'),
    '2 个限流中、1 个额度耗尽'
  );
  assert.equal(formatRejectionSummary('runtime:auth_invalid=3'), '3 个认证失效');
});

test('未知状态原样保留，不吞诊断信息', () => {
  assert.equal(formatRejectionSummary('some_new_status=2'), '2 个some_new_status');
  assert.equal(formatRejectionSummary('no_codebuddy_accounts'), '没有其他账号');
});

test('空原因不产生空括号文案', () => {
  assert.equal(formatRejectionSummary(''), '');
  assert.equal(formatRejectionSummary(null), '');
  assert.equal(formatRejectionSummary(' , '), '');
});

function createRuntimeStub(overrides = {}) {
  const calls = [];
  const runtime = createUsageStatusRuntime({
    processObj: { stdout: { write() {} }, stdin: {}, env: {} },
    provider: 'codebuddycn',
    getActiveProvider: () => 'codebuddycn',
    stateStore: { readCodexApiKeyAccountInfo: () => ({}), buildRuntimeBlockedSummary: () => '' },
    getActiveAccountRef: () => 'acct_9dc03880a872f711983e',
    getActiveCliAccountId: () => '1',
    getForwardArgs: () => [],
    isInteractiveSession: () => true,
    isCodexResumeArgs: () => false,
    isSwapping: () => false,
    hasActivePty: () => true,
    isCleanedUp: () => false,
    isAuthRecoveryPromptOpen: () => false,
    isShellDrawerVisible: () => false,
    setShellDrawerStatusSummary: () => {},
    requestAccountSwitch: () => {},
    readUsageCache: () => null,
    isUsageManagedCli: () => true,
    getUsageRemainingPercentValues: () => [],
    getSessionLabel: () => '',
    getActiveModel: () => 'deepseek-v4-pro',
    getRouteObservation: () => null,
    getSessionState: () => null,
    getNextHealthyAccount: (provider, currentId, options) => {
      calls.push({ provider, currentId, options });
      return { target: null, reason: 'runtime:rate_limited=2' };
    },
    ...overrides
  });
  return { runtime, calls };
}

test('换号失败时用同一套过滤条件问原因（当前账号 + 冷却中都要排除）', () => {
  const { runtime, calls } = createRuntimeStub({
    autoSwitchPolicy: { coolingAccountRefs: () => ['acct_07644750f320a68061a4'] }
  });
  const reason = runtime.describeRuntimeSwitchFailure({ excludeCooling: true });
  assert.equal(reason, '2 个限流中');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'codebuddycn');
  assert.equal(calls[0].currentId, '1');
  assert.equal(calls[0].options.family, true);
  assert.equal(calls[0].options.describeFailure, true);
  assert.equal(calls[0].options.model, 'deepseek-v4-pro');
  assert.deepEqual(
    calls[0].options.excludeAccountRefs,
    ['acct_07644750f320a68061a4', 'acct_9dc03880a872f711983e']
  );
});

test('选号器抛错不能把看门狗带崩：原因退化为空串', () => {
  const { runtime } = createRuntimeStub({
    getNextHealthyAccount: () => { throw new Error('db busy'); }
  });
  assert.equal(runtime.describeRuntimeSwitchFailure({ excludeCooling: true }), '');
});
