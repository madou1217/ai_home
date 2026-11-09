'use strict';

// GET /v0/webui/config 固定读 Go：与自动换号运行时同一份 config:usage。
// 这里锁住代理契约：成功透传、Go 不可用 503、不本地兜底读 config-store。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGetUsageConfigRequest } = require('../lib/server/webui-config-routes');

async function call(goResponse) {
  let response;
  const deps = goResponse === undefined ? {} : {
    goCoreSync: { getUsageConfig: async () => goResponse }
  };
  const ctx = {
    res: {},
    deps,
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  await handleGetUsageConfigRequest(ctx);
  return response;
}

test('Go 返回配置时原样透传', async () => {
  const data = {
    ok: true,
    config: {
      active_refresh_interval: '3m',
      background_refresh_interval: '1h',
      threshold_pct: 80,
      auto_switch: true,
      auto_switch_remaining_pct: 0
    }
  };
  const result = await call({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, data);
});

test('缺少 Go 宿主时 503，不回退本地配置', async () => {
  const result = await call();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});

test('Go 不可用（status 0）时 503，不本地兜底', async () => {
  const result = await call({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
});
