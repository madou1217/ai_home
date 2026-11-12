'use strict';

// 本机 profile 引导接口：只回 loopback 页面的 endpoint + 当前 Management Key。
// 鉴权门的窄口在 webui-auth-gate.test.js 里逐条锁死，这里验证返回内容。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleWebUiControlPlaneRoutes } = require('../lib/server/webui-control-plane-routes');

function runBootstrap(t, { requiredManagementKey = 'aih_mgmt_test', port = 9527 } = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cp-bootstrap-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  let status = 0;
  let payload = null;
  const ctx = {
    method: 'GET',
    pathname: '/v0/webui/control-plane/bootstrap',
    options: { port },
    requiredManagementKey,
    fs,
    aiHomeDir,
    res: {},
    writeJson: (_res, code, body) => {
      status = code;
      payload = body;
    }
  };
  return handleWebUiControlPlaneRoutes(ctx).then((handled) => ({ handled, status, payload, aiHomeDir }));
}

test('返回本机 endpoint 与当前 Management Key', async (t) => {
  const result = await runBootstrap(t);
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.profile.endpoint, 'http://127.0.0.1:9527');
  assert.equal(result.payload.profile.managementKey, 'aih_mgmt_test');
  assert.equal(result.payload.profile.state, 'ready');
});

test('端口跟随实际监听端口', async (t) => {
  const result = await runBootstrap(t, { port: 10527 });
  assert.equal(result.payload.profile.endpoint, 'http://127.0.0.1:10527');
});

test('endpoint 跟随浏览器地址栏的 loopback Host（端口映射也能对上）', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cp-bootstrap-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  let payload = null;
  await handleWebUiControlPlaneRoutes({
    method: 'GET',
    pathname: '/v0/webui/control-plane/bootstrap',
    options: { port: 9527 },
    requiredManagementKey: 'aih_mgmt_test',
    req: { headers: { host: 'localhost:19527' } },
    fs,
    aiHomeDir,
    res: {},
    writeJson: (_res, code, body) => { payload = body; }
  });
  assert.equal(payload.profile.endpoint, 'http://localhost:19527');
});

test('服务端没有配置 Key 时不返回 profile', async (t) => {
  const result = await runBootstrap(t, { requiredManagementKey: '' });
  assert.equal(result.status, 404);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'management_key_not_configured');
});

test('沿用已存 profile 的 id / name / 统计字段', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cp-bootstrap-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { saveControlPlaneProfile } = require('../lib/server/control-plane-profile-store');
  saveControlPlaneProfile({
    id: 'local',
    name: '本机网关',
    endpoint: 'http://127.0.0.1:9527',
    state: 'ready',
    managementKey: 'old-key',
    accountCount: 42
  }, {}, { fs, aiHomeDir });

  let status = 0;
  let payload = null;
  await handleWebUiControlPlaneRoutes({
    method: 'GET',
    pathname: '/v0/webui/control-plane/bootstrap',
    options: { port: 9527 },
    requiredManagementKey: 'new-key',
    fs,
    aiHomeDir,
    res: {},
    writeJson: (_res, code, body) => {
      status = code;
      payload = body;
    }
  });
  assert.equal(status, 200);
  assert.equal(payload.profile.id, 'local');
  assert.equal(payload.profile.name, '本机网关');
  assert.equal(payload.profile.accountCount, 42);
  // Key 永远是服务端当前生效值，不是 store 里的旧快照。
  assert.equal(payload.profile.managementKey, 'new-key');
});
