'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveDeviceId,
  buildDeviceStatus,
  buildDeviceAccounts,
  buildDeviceSessions,
  buildSessionMessages,
  handleNodeRpcRoutes
} = require('../lib/server/node-rpc-routes');

function baseState() {
  return {
    strategy: 'random',
    startedAt: Date.now() - 65_000,
    accounts: {
      codex: [{ accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', enabled: true, planType: 'plus', remainingPct: 62 }],
      claude: [{ accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', enabled: false }]
    },
    metrics: { totalRequests: 10, totalSuccess: 9, totalTimeouts: 1 },
    modelsCache: { ids: ['gpt-5.1', 'claude-opus-4-6'], updatedAt: 1000 },
    modelRegistry: { updatedAt: 2000 },
    executors: {},
    sessionAffinity: {}
  };
}

test('device-status 带控制面标识与队列合计', () => {
  const status = buildDeviceStatus(baseState(), { backend: 'codex-adapter', provider: 'auto' }, {}, Date.now());
  assert.equal(status.service, 'aih-control-plane');
  assert.equal(status.ok, true);
  assert.equal(status.backend, 'codex-adapter');
  assert.equal(status.totalAccounts, 2);
  assert.ok(status.serverTime);
  assert.equal(typeof status.queueTotals.running, 'number');
});

test('device-accounts 汇总按 Provider 与运行态分组', () => {
  const result = buildDeviceAccounts(baseState(), {});
  assert.equal(result.accounts.length, 2);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.byProvider.codex, 1);
  // enabled=false 映射为 down
  const claude = result.accounts.find((row) => row.provider === 'claude');
  assert.equal(claude.status, 'down');
});

test('device-sessions 跳过没有 id 的记录并给出摘要', async () => {
  const result = await buildDeviceSessions('/nonexistent-home', null);
  assert.ok(Array.isArray(result.sessions));
  assert.equal(typeof result.summary.total, 'number');
});

test('deviceId 稳定且不可反查', () => {
  const first = deriveDeviceId('/tmp/aihome');
  const second = deriveDeviceId('/tmp/aihome');
  assert.equal(first, second);
  assert.match(first, /^node-[0-9a-f]{12}$/);
  assert.notEqual(first, deriveDeviceId('/tmp/other'));
});

function createCtx({ method = 'GET', path = '/v0/node-rpc/device-status', key = 'mgmt-key', required = 'mgmt-key', search = '' } = {}) {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { chunks.push(String(body || '')); }
  };
  return {
    ctx: {
      method,
      pathname: path,
      url: new URL('http://127.0.0.1' + path + search),
      req: { headers: { authorization: 'Bearer ' + key } },
      res,
      state: baseState(),
      deps: { managementKey: required },
      options: { backend: 'codex-adapter', provider: 'auto' }
    },
    body: () => JSON.parse(chunks.join('') || 'null')
  };
}

test('鉴权失败返回 401', async () => {
  const { ctx, body } = createCtx({ key: 'wrong' });
  assert.equal(await handleNodeRpcRoutes(ctx), true);
  assert.equal(ctx.res.statusCode, 401);
  assert.equal(body().ok, false);
});

test('device-status 返回 rpc 信封与 result.status', async () => {
  const { ctx, body } = createCtx();
  await handleNodeRpcRoutes(ctx);
  assert.equal(ctx.res.statusCode, 200);
  const payload = body();
  assert.equal(payload.rpc, 'control_plane.device.status');
  assert.equal(payload.result.status.service, 'aih-control-plane');
});

test('非 node-rpc 路径不处理', async () => {
  const { ctx } = createCtx({ path: '/v0/webui/models' });
  assert.equal(await handleNodeRpcRoutes(ctx), false);
});

//
// 会话消息：运行时优先于落盘。真机上大多数会话只在运行时里，
// 只查落盘会出现「列表里有、点进去 404」。
test('buildSessionMessages 优先读运行时会话', () => {
  const runtime = {
    store: {
      getSession: (id) => (id === 's1'
        ? { id: 's1', project: '/p/demo', provider: 'codex', title: 'demo', updatedAt: 10, createdAt: 5,
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: 'hello' },
              { role: 'tool', content: 'ignored' }
            ] }
        : null)
    }
  };
  const result = buildSessionMessages('', runtime, 's1', 0);
  assert.ok(result);
  assert.equal(result.messages.length, 2, '非 user/assistant 消息应被过滤');
  assert.equal(result.summary.total, 2);
  assert.equal(result.session.projectRef, '/p/demo');
});

test('buildSessionMessages 支持 limit 截断并标记 truncated', () => {
  const runtime = {
    store: {
      getSession: () => ({
        id: 's1', messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'user', content: 'c' }
        ]
      })
    }
  };
  const result = buildSessionMessages('', runtime, 's1', 2);
  assert.equal(result.messages.length, 2);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.summary.total, 3);
});

test('buildSessionMessages 找不到会话时返回 null', () => {
  assert.equal(buildSessionMessages('', null, 'missing', 0), null);
  assert.equal(buildSessionMessages('', null, '', 0), null);
});
