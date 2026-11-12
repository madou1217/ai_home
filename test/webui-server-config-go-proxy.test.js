'use strict';

// GET /v0/webui/server-config 固定读 Go：公开视图（密钥隐藏）由 Go 产出。
// 这里锁住代理契约：成功透传、Go 不可用 503、不本地 readServerConfig。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGetServerConfigRequest, handleSetServerConfigRequest } = require('../lib/server/webui-config-routes');

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

async function callWrite(options = {}) {
  let captured;
  let forwarded = null;
  const deps = options.goResponse === undefined ? {} : {
    goCoreSync: {
      setServerConfig: async (patch) => {
        forwarded = patch;
        return options.goResponse;
      }
    }
  };
  const ctx = {
    res: {},
    deps,
    readRequestBody: async () => Buffer.from(options.body === undefined ? '{"config":{"port":8080}}' : options.body, 'utf8'),
    writeJson: (_res, status, payload) => { captured = { status, payload }; }
  };
  await handleSetServerConfigRequest(ctx);
  return { captured, forwarded };
}

test('server 配置 POST：写 Go 并透传公开视图', async () => {
  const data = { ok: true, config: { host: '127.0.0.1', port: 8080, apiKey: '', managementKey: '', apiKeyConfigured: true, managementKeyConfigured: false } };
  const result = await callWrite({ goResponse: { ok: true, status: 200, data } });
  assert.equal(result.captured.status, 200);
  assert.deepEqual(result.captured.payload, data);
  assert.deepEqual(result.forwarded, { port: 8080 });
});

test('server 配置 POST：managementKey 变更被拒绝，不调用 Go', async () => {
  const result = await callWrite({ body: '{"config":{"managementKey":"new"}}', goResponse: { ok: true, status: 200, data: {} } });
  assert.equal(result.captured.status, 400);
  assert.equal(result.captured.payload.error, 'management_key_rotation_required');
  assert.equal(result.forwarded, null);
});

test('server 配置 POST：缺少 Go 宿主时 503', async () => {
  const result = await callWrite();
  assert.equal(result.captured.status, 503);
  assert.equal(result.captured.payload.error, 'go_core_unavailable');
});
