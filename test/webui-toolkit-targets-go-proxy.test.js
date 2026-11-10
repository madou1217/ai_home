'use strict';

// GET /v0/webui/toolkit/environments/targets 固定读 Go：本机 + SSH 连接的组装已迁 Go。
// 这里锁住代理契约：成功透传、Go 不可用 503、不本地读 ssh_connections。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiEnvironmentRoutes } = require('../lib/server/webui-environment-routes');

async function call(goResponse) {
  let response;
  const deps = goResponse === undefined ? {} : {
    goCoreSync: { getToolkitTargets: async () => goResponse }
  };
  const ctx = {
    method: 'GET',
    pathname: '/v0/webui/toolkit/environments/targets',
    url: new URL('http://127.0.0.1/v0/webui/toolkit/environments/targets'),
    res: {},
    deps,
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  const handled = await handleWebUiEnvironmentRoutes(ctx);
  assert.equal(handled, true);
  return response;
}

test('执行目标：Go 返回列表时原样透传', async () => {
  const data = {
    ok: true,
    targets: [
      { kind: 'local', id: 'local', label: '本机（AIH Server）' },
      { kind: 'ssh', id: 'ssh:conn_0123456789abcdef', label: 'prod', host: 'dev@10.0.0.1' }
    ]
  };
  const result = await call({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, data);
});

test('执行目标：缺少 Go 宿主时 503', async () => {
  const result = await call();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});

test('执行目标：Go 不可用时 503', async () => {
  const result = await call({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
});
