'use strict';

// GET /v0/webui/server-config 固定读 Go：公开视图（密钥隐藏）由 Go 产出。
// 这里锁住代理契约：成功透传、Go 不可用 503、不本地 readServerConfig。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGetServerConfigRequest } = require('../lib/server/webui-config-routes');

async function call(goResponse) {
  let response;
  const deps = goResponse === undefined ? {} : {
    goCoreSync: { getServerConfig: async () => goResponse }
  };
  const ctx = {
    res: {},
    deps,
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  await handleGetServerConfigRequest(ctx);
  return response;
}

test('server 配置：Go 返回公开视图时原样透传', async () => {
  const data = {
    ok: true,
    config: {
      host: '127.0.0.1', port: 9527,
      apiKey: '', managementKey: '',
      apiKeyConfigured: true, managementKeyConfigured: false
    }
  };
  const result = await call({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, data);
  assert.equal(result.payload.config.apiKey, '');
});

test('server 配置：缺少 Go 宿主时 503，不回退本地配置', async () => {
  const result = await call();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});

test('server 配置：Go 不可用时 503', async () => {
  const result = await call({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
});
