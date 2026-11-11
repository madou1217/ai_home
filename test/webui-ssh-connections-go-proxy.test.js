'use strict';

// GET /v0/webui/ssh-connections 固定读 Go：脱敏后的连接列表由 Go 产出。
// 这里锁住代理契约：成功透传、Go 不可用 503、不本地读 ssh_connections。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiSshHostRoutes } = require('../lib/server/webui-ssh-host-routes');

async function call(goResponse) {
  let response;
  const deps = {
    fs: {},
    readRequestBody: async () => Buffer.alloc(0),
    spawnImpl: () => {},
    homeDir: '/tmp',
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  if (goResponse !== undefined) {
    deps.goCoreSync = { getSshConnections: async () => goResponse };
  }
  const ctx = {
    method: 'GET',
    pathname: '/v0/webui/ssh-connections',
    res: {},
    aiHomeDir: '/tmp/ai-home',
    deps
  };
  const handled = await handleWebUiSshHostRoutes(ctx);
  assert.equal(handled, true);
  return response;
}

test('Go 返回脱敏列表时原样透传', async () => {
  const data = {
    ok: true,
    connections: [
      { id: 'c1', label: 'prod', host: '10.0.0.1', port: 22, password: '******', privateKey: '' }
    ]
  };
  const result = await call({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, data);
});

test('缺少 Go 宿主时 503，不本地读连接表', async () => {
  const result = await call();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});

test('Go 不可用（status 0）时 503', async () => {
  const result = await call({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
});

async function callWorkspaces(goResponse) {
  let response;
  const deps = {
    fs: {},
    readRequestBody: async () => Buffer.alloc(0),
    spawnImpl: () => {},
    homeDir: '/tmp',
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  if (goResponse !== undefined) {
    deps.goCoreSync = { getSshWorkspaces: async () => goResponse };
  }
  const ctx = {
    method: 'GET',
    pathname: '/v0/webui/ssh-workspaces',
    res: {},
    aiHomeDir: '/tmp/ai-home',
    deps
  };
  const handled = await handleWebUiSshHostRoutes(ctx);
  assert.equal(handled, true);
  return response;
}

test('SSH 工作区：Go 返回列表时原样透传', async () => {
  const data = {
    ok: true,
    workspaces: [
      { id: 'ws_0123456789abcdef', projectPath: '/tmp/ai-home/run/remote-workspaces/ws_0123456789abcdef' }
    ]
  };
  const result = await callWorkspaces({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, data);
});

test('SSH 工作区：缺少 Go 宿主时 503', async () => {
  const result = await callWorkspaces();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});

test('SSH 工作区：Go 不可用时 503', async () => {
  const result = await callWorkspaces({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
});

async function callWorkspaceSessions(goResponse) {
  let response;
  const deps = {
    fs: {},
    readRequestBody: async () => Buffer.alloc(0),
    spawnImpl: () => {},
    homeDir: '/tmp',
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  if (goResponse !== undefined) {
    deps.goCoreSync = { getSshWorkspaceSessions: async () => goResponse };
  }
  const ctx = {
    method: 'GET',
    pathname: '/v0/webui/ssh-workspaces/sessions',
    res: {},
    aiHomeDir: '/tmp/ai-home',
    deps
  };
  const handled = await handleWebUiSshHostRoutes(ctx);
  assert.equal(handled, true);
  return response;
}

test('SSH 工作区终端状态：Go 返回列表时原样透传', async () => {
  const data = {
    ok: true,
    sessions: [
      { workspaceId: 'ws_0123456789abcdef', sessionKey: 'remote-ws:ws_0123456789abcdef', alive: true }
    ]
  };
  const result = await callWorkspaceSessions({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, data);
});

test('SSH 工作区终端状态：缺少 Go 宿主时 503', async () => {
  const result = await callWorkspaceSessions();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});

test('SSH 工作区终端状态：Go 不可用时 503', async () => {
  const result = await callWorkspaceSessions({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
});
async function callBrowse(goResponse) {
  let response;
  const deps = {
    fs: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({ connectionId: 'c1', subDir: '/tmp' })),
    spawnImpl: () => {},
    homeDir: '/tmp',
    writeJson: (_res, status, payload) => { response = { status, payload }; }
  };
  if (goResponse !== undefined) {
    deps.goCoreSync = { browseSshHost: async () => goResponse };
  }
  const ctx = {
    method: 'POST',
    pathname: '/v0/webui/ssh-hosts/browse',
    req: {},
    res: {},
    aiHomeDir: '/tmp/ai-home',
    deps
  };
  const handled = await handleWebUiSshHostRoutes(ctx);
  assert.equal(handled, true);
  return response;
}

test('SSH 目录浏览：Go 成功时透传 currentDir/entries', async () => {
  const data = { ok: true, currentDir: '/tmp', entries: [{ name: 'a', path: '/tmp/a', type: 'directory' }] };
  const result = await callBrowse({ ok: true, status: 200, data });
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.deepEqual(result.payload.entries, data.entries);
});

test('SSH 目录浏览：Go 不可用时 503，不本地回退', async () => {
  const result = await callBrowse({ ok: false, status: 0, errorCode: 'go_core_unavailable' });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_unavailable');
});
