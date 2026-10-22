'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listCrossProviderFallbacks } = require('../lib/server/cross-provider-fallback');

const WB_1 = 'acct_11111111111111111111';
const WB_2 = 'acct_22222222222222222222';
const CB_1 = 'acct_33333333333333333333';

function account(accountRef, provider, models) {
  return { accountRef, provider, accessToken: 'token', schedulableStatus: 'schedulable', availableModels: models };
}

function stateWith(accounts) {
  const byAccount = {};
  Object.entries(accounts).forEach(([provider, list]) => {
    list.forEach((item) => { byAccount[item.accountRef] = item.availableModels; });
  });
  return { accounts, webUiModelsCache: { updatedAt: 1, byAccount, errorsByAccount: {} } };
}

// 2026-10-22 真机：gemini-3.5-flash 同时被 workbuddy 与 codebuddy 探测到，但路由只锁定一个
// provider，另一个的持有者被 provider 边界完全排除 —— 选中池全被上游拒时请求直接失败，
// 明明还有别的 provider 能服务。用户原话：「这和我们一个一个手动切换有什么区别？」
test('lists other providers that can serve the model, most accounts first', () => {
  const state = stateWith({
    workbuddy: [account(WB_1, 'workbuddy', ['gemini-3.5-flash']), account(WB_2, 'workbuddy', ['gemini-3.5-flash'])],
    codebuddy: [account(CB_1, 'codebuddy', ['gemini-3.5-flash'])]
  });

  // 当前 provider 自己排除在外（它整个池已经试过了）。
  assert.deepEqual(listCrossProviderFallbacks({ state, options: {}, model: 'gemini-3.5-flash', currentProvider: 'workbuddy' }),
    [{ provider: 'codebuddy', accountCount: 1 }]);
  // 反向同理：从 codebuddy 看，workbuddy 有 2 个可用账号，排在前面。
  assert.deepEqual(listCrossProviderFallbacks({ state, options: {}, model: 'gemini-3.5-flash', currentProvider: 'codebuddy' }),
    [{ provider: 'workbuddy', accountCount: 2 }]);
});

test('providers without a schedulable account for the model are not candidates', () => {
  const state = stateWith({
    workbuddy: [account(WB_1, 'workbuddy', ['gemini-3.5-flash'])],
    // 目录里没有这个模型 → 回落过去只会换来一个必然失败的请求。
    codebuddy: [account(CB_1, 'codebuddy', ['gpt-5.5'])]
  });
  assert.deepEqual(listCrossProviderFallbacks({ state, options: {}, model: 'gemini-3.5-flash', currentProvider: 'workbuddy' }), []);
});

test('missing model or state yields no candidates', () => {
  const state = stateWith({ workbuddy: [account(WB_1, 'workbuddy', ['gemini-3.5-flash'])] });
  assert.deepEqual(listCrossProviderFallbacks({ state, options: {}, model: '', currentProvider: 'workbuddy' }), []);
  assert.deepEqual(listCrossProviderFallbacks({ state: null, options: {}, model: 'x', currentProvider: 'workbuddy' }), []);
});
