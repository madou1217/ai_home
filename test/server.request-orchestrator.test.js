const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithAccountAttempts } = require('../lib/server/request-orchestrator');
const { chooseServerAccount } = require('../lib/server/account-selector');

const MODEL = 'gpt-5.6-sol';

// 造一个真实形状的账号池：两个只是被软冷却（一次本地代理抖动导致的
// ECONNREFUSED），一个被配额硬阻断。用真的 chooseServerAccount，才能同时验证
// 「软的放行」和「硬的仍拦住」——换成桩函数就只是在测桩。
function buildPool(now) {
  return [
    {
      accountRef: 'acct_soft_1',
      apiKeyMode: true,
      schedulableStatus: 'schedulable',
      modelCooldowns: { [MODEL]: now + 30000 },
      lastError: 'fetch failed [ECONNREFUSED]'
    },
    {
      accountRef: 'acct_soft_2',
      apiKeyMode: true,
      schedulableStatus: 'schedulable',
      modelCooldowns: { [MODEL]: now + 30000 },
      lastError: 'fetch failed [ECONNREFUSED]'
    },
    {
      accountRef: 'acct_hard_quota',
      apiKeyMode: true,
      schedulableStatus: 'blocked_by_quota',
      quotaReason: 'usage_exhausted'
    }
  ];
}

function runAttempts(pool, options = {}) {
  const attempted = [];
  return runWithAccountAttempts({
    pool,
    maxAttempts: 5,
    chooseServerAccount,
    selectionState: { cursors: {} },
    cursorState: {},
    cursorKey: 'codex',
    provider: 'codex',
    model: MODEL,
    ...options,
    onAttempt: async (account, control) => {
      attempted.push(account.accountRef);
      control.setLastError('fetch failed [ECONNREFUSED]');
      return { action: 'retry_next' };
    }
  }).then((orchestration) => ({ orchestration, attempted }));
}

test('全池软冷却时仍然真打上游，而不是谎报没有可调度账号', async () => {
  const now = Date.now();
  const { orchestration, attempted } = await runAttempts(buildPool(now));

  // 逃生阀必须是粘性的：两个软冷却账号都要被走到。只放行一次的话这里只有 1 个，
  // 第一个失败后又会退回 no_account，客户端照样收到假的 no_available_account。
  assert.deepEqual(attempted.sort(), ['acct_soft_1', 'acct_soft_2']);

  // 真实的上游失败必须带回来。调用方正是靠它（lastFailurePolicy / 失败留档）
  // 判定该回真实的传输失败还是账号池摘要——一次都没打过时它是空的，于是只能
  // 回退到「没有可调度账号」这个谎报。kind 仍是 no_account 是刻意保留的：
  // upstream-endpoints 的失败留档分支依赖这个取值，不能为了好看而改动。
  assert.equal(orchestration.lastError, 'fetch failed [ECONNREFUSED]');
  assert.ok(orchestration.attemptedAccountRefs.size > 0, '上游一次都没被真打');
});

test('配额硬阻断的账号不因逃生阀被放行', async () => {
  const now = Date.now();
  const { attempted } = await runAttempts(buildPool(now));

  assert.ok(
    !attempted.includes('acct_hard_quota'),
    '硬阻断被越过了：逃生阀只该放行软冷却'
  );
});

test('只剩硬阻断账号时不做无谓尝试，交回 no_account', async () => {
  const pool = buildPool(Date.now()).filter(
    (account) => account.accountRef === 'acct_hard_quota'
  );
  const { orchestration, attempted } = await runAttempts(pool);

  assert.equal(attempted.length, 0);
  assert.equal(orchestration.kind, 'no_account');
});

test('有干净账号时优先用它，不提前打开逃生阀', async () => {
  const now = Date.now();
  const pool = buildPool(now);
  pool.push({
    accountRef: 'acct_healthy',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  });

  const attempted = [];
  await runWithAccountAttempts({
    pool,
    maxAttempts: 5,
    chooseServerAccount,
    selectionState: { cursors: {} },
    cursorState: {},
    cursorKey: 'codex',
    provider: 'codex',
    model: MODEL,
    onAttempt: async (account) => {
      attempted.push(account.accountRef);
      return { action: 'return', value: 'served' };
    }
  });

  assert.deepEqual(attempted, ['acct_healthy']);
});
