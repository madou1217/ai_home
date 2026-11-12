'use strict';

// 真机验证：用真实 Go Core 跑一遍切片 C 的写路径。
//
// 默认跳过（需要运行中的 Go Core 与管理密钥）；设置 AIH_GO_MANAGEMENT_URL 与
// AIH_GO_MANAGEMENT_KEY 后执行：
//   AIH_GO_MANAGEMENT_URL=http://127.0.0.1:19550 AIH_GO_MANAGEMENT_KEY=... \
//     node --test test/alias-go-owner-live.test.js
//
// 它验证的是「Node 侧映射」与「Go 真实响应」拼在一起的行为，不是 Node 服务里的接线；
// 接线要等 Node 重启后才生效。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGoManagementClient } = require('../lib/account/go-bridge/go-management-client');
const { handleAliasRouteViaGo } = require('../lib/server/alias-go-owner');

const BASE_URL = String(process.env.AIH_GO_MANAGEMENT_URL || '').trim();
const KEY = String(process.env.AIH_GO_MANAGEMENT_KEY || '').trim();
const enabled = BASE_URL !== '' && KEY !== '';

function createHost() {
  const client = createGoManagementClient({ baseUrl: BASE_URL, managementKey: KEY, timeoutMs: 15000 });
  return {
    isEnabled: () => true,
    listModelAliases: () => client.send({ method: 'GET', path: '/v1/management/webui/model-aliases' }),
    createModelAlias: (record) => client.send({ method: 'POST', path: '/v1/management/webui/model-aliases', body: record }),
    updateModelAlias: (id, patch) => client.send({ method: 'PUT', path: '/v1/management/webui/model-aliases/' + encodeURIComponent(id), body: patch }),
    deleteModelAlias: (id) => client.send({ method: 'DELETE', path: '/v1/management/webui/model-aliases/' + encodeURIComponent(id) }),
    setModelAliasEnabled: (id, value) => client.send({
      method: 'POST',
      path: '/v1/management/webui/model-aliases/' + encodeURIComponent(id) + '/enabled',
      body: { enabled: value === true }
    })
  };
}

function createCtx(t, state) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-live-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return async (method, pathname, body) => {
    const res = { statusCode: 0, payload: null };
    await handleAliasRouteViaGo({
      req: {},
      res,
      method,
      pathname,
      state,
      deps: {
        fs,
        aiHomeDir,
        goCoreSync: createHost(),
        readRequestBody: async () => Buffer.from(JSON.stringify(body || {})),
        writeJson: (target, status, payload) => { target.statusCode = status; target.payload = payload; }
      }
    });
    return res;
  };
}

test('真机：创建 → 列表 → 停用 → 删除', { skip: !enabled && '未设置 AIH_GO_MANAGEMENT_URL/KEY' }, async (t) => {
  const state = { modelAliases: { aliases: [] } };
  const call = createCtx(t, state);

  const created = await call('POST', '/v0/webui/model-aliases', {
    alias: 'zz-live-probe',
    target: 'glm-5.3-flash',
    targetProvider: 'zcode'
  });
  assert.equal(created.statusCode, 200, JSON.stringify(created.payload));
  const id = created.payload.alias.id;
  assert.ok(id, '创建没有返回 id');

  // 写成功后本地投影应该已经包含它（refreshProjection 的效果）。
  assert.ok(state.modelAliases.aliases.some((row) => row.id === id), '本地投影没有刷新');

  const toggled = await call('POST', '/v0/webui/model-aliases/' + id + '/toggle');
  assert.equal(toggled.statusCode, 200, JSON.stringify(toggled.payload));
  assert.equal(toggled.payload.alias.enabled, false);

  const removed = await call('DELETE', '/v0/webui/model-aliases/' + id);
  assert.equal(removed.statusCode, 200, JSON.stringify(removed.payload));

  const listed = await call('GET', '/v0/webui/model-aliases');
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.aliases.some((row) => row.id === id), false, '删除后仍在列表里');
});

