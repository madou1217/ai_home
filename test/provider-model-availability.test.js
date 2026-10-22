'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TTL_MS,
  clearProviderModelUnavailable,
  isModelUnavailableForProvider,
  markModelUnavailableForProvider,
  resetModelAvailabilityRegistry,
  snapshotModelAvailability
} = require('../lib/server/provider-model-availability');

test('records and reads back a provider-level model denial', (t) => {
  t.after(resetModelAvailabilityRegistry);
  resetModelAvailabilityRegistry();

  assert.equal(isModelUnavailableForProvider('agy', 'gemini-3.5-flash'), false);
  markModelUnavailableForProvider('agy', 'gemini-3.5-flash');
  assert.equal(isModelUnavailableForProvider('agy', 'gemini-3.5-flash'), true);
  // 大小写与空白归一：同一事实的不同写法不该各记一份。
  assert.equal(isModelUnavailableForProvider('AGY', ' Gemini-3.5-Flash '), true);
  // 只影响这一对：同 provider 的其它模型、同模型的其它 provider 都不受影响。
  assert.equal(isModelUnavailableForProvider('agy', 'gemini-3.5-flash-low'), false);
  assert.equal(isModelUnavailableForProvider('codebuddy', 'gemini-3.5-flash'), false);
});

test('the record expires on its own so a re-listed model comes back', (t) => {
  t.after(resetModelAvailabilityRegistry);
  resetModelAvailabilityRegistry();
  const now = 1_000_000;

  markModelUnavailableForProvider('agy', 'gemini-3.5-flash', { now, ttlMs: 60_000 });
  assert.equal(isModelUnavailableForProvider('agy', 'gemini-3.5-flash', now + 59_999), true);
  assert.equal(isModelUnavailableForProvider('agy', 'gemini-3.5-flash', now + 60_001), false);
});

test('clearing a provider drops only that provider', (t) => {
  t.after(resetModelAvailabilityRegistry);
  resetModelAvailabilityRegistry();

  markModelUnavailableForProvider('agy', 'm');
  markModelUnavailableForProvider('codebuddy', 'm');
  clearProviderModelUnavailable('agy');
  assert.equal(isModelUnavailableForProvider('agy', 'm'), false);
  assert.equal(isModelUnavailableForProvider('codebuddy', 'm'), true);
});

test('empty inputs are ignored instead of recording a bogus fact', (t) => {
  t.after(resetModelAvailabilityRegistry);
  resetModelAvailabilityRegistry();

  markModelUnavailableForProvider('', 'm');
  markModelUnavailableForProvider('agy', '');
  assert.deepEqual(snapshotModelAvailability(), {});
  assert.equal(DEFAULT_TTL_MS, 30 * 60 * 1000);
});

// 闭环验证：上游拒绝 → 登记 → 路由不再选它 → 目录刷新后恢复。
// 2026-10-22 真机：gemini-3.5-flash 被前缀推断成 agy 家族、agy 目录残留该裸名，
// 路由每次都送 agy，上游每次都拒 —— 错误周而复始。登记事实后不再重演。
test('routing skips a provider the upstream already denied for that model', (t) => {
  t.after(resetModelAvailabilityRegistry);
  resetModelAvailabilityRegistry();
  const { resolveGatewayProvider } = require('../lib/server/capability-router');

  const state = {
    accounts: {
      agy: [{ accountRef: 'acct_33333333333333333333', provider: 'agy', accessToken: 't',
        availableModels: ['gemini-3.5-flash', 'gemini-3.5-flash-low'] }],
      workbuddy: [{ accountRef: 'acct_77777777777777777777', provider: 'workbuddy', accessToken: 't',
        availableModels: ['gemini-3.5-flash'] }]
    },
    webUiModelsCache: {
      byProvider: { agy: ['gemini-3.5-flash'], workbuddy: ['gemini-3.5-flash'] }
    }
  };
  const ask = () => resolveGatewayProvider({
    options: { provider: 'auto' }, state,
    requestJson: { model: 'gemini-3.5-flash' }, headers: {}, clientProtocol: 'openai_responses'
  });

  // 上游还没拒绝过：家族推断把 gemini-* 判给 agy（agy 目录里确实有这个名字）。
  assert.equal(ask().provider, 'agy');

  // 上游拒绝后：agy 不再入选，落到真正能服务的 workbuddy。
  markModelUnavailableForProvider('agy', 'gemini-3.5-flash');
  assert.equal(ask().provider, 'workbuddy');

  // ���录刷新确认 agy 的清单（上游可能已上架回来）→ 事实被清，agy 重新可选。
  clearProviderModelUnavailable('agy');
  assert.equal(ask().provider, 'agy');
});
