const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WEBUI_MODELS_REFRESH_TIMEOUT_MS
} = require('../lib/server/webui-model-cache');
const {
  startModelCatalogRefreshJob
} = require('../lib/server/webui-openai-model-routes');

// 2026-10-16 kiro 事故：账号页「刷新」触发的模型目录作业沿用了后台调度的 2.5s 探测预算，
// 冷启动 ListAvailableModels（实测 ~1.6s，繁忙时更久）被截断 → HTTP 策略静默失败 →
// 掉回 CLI 兜底报 native_cli_model_discovery_cli_not_found（真实原因是超时）。
// 显式刷新是用户在等结果的操作，必须带足冷启动预算。
test('显式刷新的模型目录作业使用显式刷新预算，而不是后台调度的 2.5s', async () => {
  assert.ok(
    WEBUI_MODELS_REFRESH_TIMEOUT_MS > 2500,
    '显式刷新预算必须显著大于后台调度的 2.5s 默认值，否则冷启动仍会被截断'
  );

  const accountRef = 'acct_0123456789abcdefabcd';
  const account = { accountRef, provider: 'kiro', accessToken: 'token', email: 'kiro@example.com' };
  const seenTimeouts = [];
  const ctx = {
    state: { accounts: { kiro: [account] }, modelRegistry: { providers: {} } },
    options: {},
    deps: {
      fetchModelsForAccount: async (_options, _target, timeoutMs) => {
        seenTimeouts.push(timeoutMs);
        return ['model-a'];
      }
    }
  };

  const { job } = startModelCatalogRefreshJob(ctx, { accountRef });
  await job.completion;

  assert.equal(job.status, 'succeeded', job.error);
  assert.deepEqual(seenTimeouts, [WEBUI_MODELS_REFRESH_TIMEOUT_MS]);
  assert.deepEqual(job.catalog.byAccountRef[accountRef], ['model-a']);
});
