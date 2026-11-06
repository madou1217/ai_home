'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchGoAccountRows,
  assembleAccountList,
  assembleAccountListWithGo,
  resetGoAccountRowsState
} = require('../lib/server/account-row-live');

function nodeRow(overrides = {}) {
  return {
    provider: 'codex',
    accountRef: 'acct_node1',
    status: 'up',
    displayName: 'proxy.meadeo.com',
    configured: true,
    apiKeyMode: true,
    planType: 'api-key',
    email: 'me@example.com',
    updatedAt: 1793931552597,
    ...overrides
  };
}

function goRow(overrides = {}) {
  return {
    account_ref: 'acct_go1',
    provider_id: 'codex',
    enabled: true,
    has_credential: true,
    display_name: 'proxy.meadeo.com',
    email: 'me@example.com',
    subscription_kind: 'api-key',
    ...overrides
  };
}

function hostWith(pages) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    listManagementAccounts: async (query) => {
      calls.push(query);
      const page = pages.shift() || { ok: true, data: [], page: null };
      return page;
    }
  };
}

test('拉取 Go 账号视图：单页', async () => {
  resetGoAccountRowsState();
  const host = hostWith([{ ok: true, data: [goRow()], page: null }]);
  const result = await fetchGoAccountRows(host);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(host.calls.length, 1);
});

test('拉取 Go 账号视图：按 next_after_ref 翻页', async () => {
  resetGoAccountRowsState();
  const host = hostWith([
    { ok: true, data: [goRow({ account_ref: 'a' })], page: { next_after_ref: 'a' } },
    { ok: true, data: [goRow({ account_ref: 'b' })], page: null }
  ]);
  const result = await fetchGoAccountRows(host);
  assert.deepEqual(result.rows.map((row) => row.account_ref), ['a', 'b']);
  assert.equal(host.calls[1].afterRef, 'a');
});

test('Go 不可用时进入冷却，冷却期内不再打 Go', async () => {
  resetGoAccountRowsState();
  const host = hostWith([{ ok: false, errorCode: 'go_core_unavailable' }]);
  const first = await fetchGoAccountRows(host);
  assert.equal(first.ok, false);
  assert.equal(first.errorCode, 'go_core_unavailable');
  const second = await fetchGoAccountRows(host);
  assert.equal(second.ok, false);
  assert.equal(second.errorCode, 'go_core_cooldown');
  assert.equal(host.calls.length, 1, '冷却期不应再请求 Go');
});

test('Go 超时按失败处理，不阻塞列表', async () => {
  resetGoAccountRowsState();
  // 故意让 Go 的响应晚于超时返回：超时分支必须先生效，且不留下悬挂的 Promise。
  const host = {
    isEnabled: () => true,
    listManagementAccounts: () => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, data: [] }), 200);
    })
  };
  const startedAt = Date.now();
  const result = await fetchGoAccountRows(host, { timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'go_core_timeout');
  assert.ok(Date.now() - startedAt < 1000, '超时必须快速返回');
});

test('go core 未启用时直接跳过', async () => {
  resetGoAccountRowsState();
  const host = { isEnabled: () => false, listManagementAccounts: async () => ({ ok: true, data: [] }) };
  const result = await fetchGoAccountRows(host);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'go_core_disabled');
});

test('没有 goHost / 取数失败时原样返回 Node 行', async () => {
  resetGoAccountRowsState();
  const rows = [nodeRow()];
  const noHost = await assembleAccountListWithGo({}, rows);
  assert.equal(noHost.goAssembled, false);
  assert.deepEqual(noHost.accounts, rows);

  const failing = await assembleAccountListWithGo(
    { goCoreSync: hostWith([{ ok: false, errorCode: 'go_core_unavailable' }]) },
    rows
  );
  assert.equal(failing.goAssembled, false);
  assert.deepEqual(failing.accounts, rows);
});

test('ref 翻译后对齐，Go 的判定覆盖到 Node 行', async () => {
  resetGoAccountRowsState();
  const rows = [nodeRow({ accountRef: 'acct_node1', status: 'up' })];
  const host = hostWith([{ ok: true, data: [goRow({ account_ref: 'acct_go1', enabled: false })], page: null }]);
  const result = await assembleAccountListWithGo(
    { goCoreSync: host, goAccountRefFor: (ref) => (ref === 'acct_node1' ? 'acct_go1' : ref) },
    rows
  );
  assert.equal(result.goAssembled, true);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.accounts[0].status, 'down');
});

test('Go 里没有的账号（Node-only Provider）原样保留', async () => {
  resetGoAccountRowsState();
  const rows = [nodeRow({ accountRef: 'acct_gemini', provider: 'gemini' })];
  const result = assembleAccountList(rows, [], null);
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.accounts, rows);
});

test('装配不制造差异时 changed=0（翻转前必须成立）', async () => {
  resetGoAccountRowsState();
  const rows = [nodeRow()];
  const result = assembleAccountList(rows, [goRow({ account_ref: 'acct_node1' })], null);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.accounts, rows);
});

test('Vertex 占位账号的 status 仍沿用 Node', async () => {
  resetGoAccountRowsState();
  const rows = [nodeRow({ provider: 'gemini', status: 'up' })];
  const result = assembleAccountList(
    rows,
    [goRow({ provider_id: 'gemini', enabled: false, auth_kind: 'vertex_ai' })],
    null
  );
  assert.equal(result.accounts[0].status, 'up');
  assert.equal(result.changed, 0);
});
