'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildModelAccountIndex } = require('../lib/server/model-account-index');
const { selectPoolAccountsForModel } = require('../lib/server/model-account-pool-selector');

const ENABLED = 'acct_1111111111111111aaaa';
const DISABLED = 'acct_2222222222222222bbbb';
const MODEL = 'gpt-5.6-sol';

function account(accountRef) {
  return {
    accountRef,
    accessToken: 'token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
}

function makeState(disabledRefs) {
  const pool = [account(ENABLED), account(DISABLED)];
  const state = {
    accounts: { codex: pool },
    // 两个账号的探测目录一模一样：唯一的差别只有用户设置。
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: {
        [ENABLED]: [MODEL, 'gpt-5.6-luna'],
        [DISABLED]: [MODEL, 'gpt-5.6-luna']
      },
      byProvider: {}
    },
    modelCatalogSettings: {
      accountModels: disabledRefs.map((accountRef) => ({
        id: MODEL,
        provider: 'codex',
        accountRef,
        enabled: false
      }))
    }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});
  return { state, pool };
}

function select(state, pool, model = MODEL) {
  return selectPoolAccountsForModel({ pool, provider: 'codex', model, state, options: {} });
}

test('显式停用的 (账号, 模型) 被剔除出池', () => {
  const { state, pool } = makeState([DISABLED]);
  const result = select(state, pool);
  assert.deepEqual(result.pool.map((item) => item.accountRef), [ENABLED]);
  assert.equal(result.filtered, true);
  assert.equal(result.excludedAccountRefs.includes(DISABLED), true);
});

test('停用只针对被停的那个模型，同账号其它模型不受影响', () => {
  const { state, pool } = makeState([DISABLED]);
  const result = select(state, pool, 'gpt-5.6-luna');
  assert.deepEqual(
    result.pool.map((item) => item.accountRef).sort(),
    [ENABLED, DISABLED].sort()
  );
});

test('没有设置记录一律视为启用——不改变默认语义', () => {
  const { state, pool } = makeState([]);
  const result = select(state, pool);
  assert.equal(result.pool.length, 2);
});

// 全池都被停用时给出「没有账号能服务」的终判，由调用方渲染 503，
// 而不是退回整池去拨一个用户明确关掉的上游。
//
// 注意：此时 provider-routing 的 getModelBindingScore 仍会算作「有可调度绑定」
// （它查倒排索引，看不到停用开关），所以别名 fallback 不会接手，请求就停在 503。
// 这个分歧是已知的，见 PR 说明；这里先把选池侧的行为钉住。
test('全部账号都停用该模型时排空池子', () => {
  const { state, pool } = makeState([ENABLED, DISABLED]);
  const result = select(state, pool);
  assert.deepEqual(result.pool, []);
  assert.equal(result.filtered, true);
  assert.deepEqual(result.excludedAccountRefs.sort(), [ENABLED, DISABLED].sort());
});

// 额度窗口门禁：窗口已耗尽且未重置的 (账号, 模型) 不进候选池 —— 预防优于 429。
test('额度窗口耗尽的账号被摘出候选池，窗口重置后恢复', () => {
  const now = Date.now();
  const exhausted = {
    accountRef: ENABLED,
    schedulableStatus: 'schedulable',
    usageSnapshot: {
      capturedAt: now - 60000,
      models: [{ model: MODEL, remainingPct: 0, resetAtMs: now + 3600000 }]
    }
  };
  const healthy = {
    accountRef: DISABLED,
    schedulableStatus: 'schedulable',
    usageSnapshot: {
      capturedAt: now - 60000,
      models: [{ model: MODEL, remainingPct: 100, resetAtMs: 0 }]
    }
  };
  const state = {
    accounts: { agy: [exhausted, healthy] },
    webUiModelsCache: {
      updatedAt: now,
      byAccount: { [ENABLED]: [MODEL], [DISABLED]: [MODEL] },
      byProvider: {}
    }
  };
  const result = selectPoolAccountsForModel({
    pool: [exhausted, healthy], provider: 'agy', model: MODEL, state, options: {}
  });
  assert.deepEqual(result.pool.map((item) => item.accountRef), [DISABLED]);
  assert.deepEqual(result.windowExhaustedAccountRefs, [ENABLED]);
  // 窗口已重置（resetAtMs 在过去）→ 重新进池。
  const reset = { ...exhausted,
    usageSnapshot: { ...exhausted.usageSnapshot,
      models: [{ model: MODEL, remainingPct: 0, resetAtMs: now - 1000 }] } };
  const after = selectPoolAccountsForModel({
    pool: [reset, healthy], provider: 'agy', model: MODEL, state, options: {}
  });
  assert.equal(after.pool.length, 2);
  assert.equal(after.windowExhaustedAccountRefs, undefined);
});
