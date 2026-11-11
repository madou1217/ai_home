'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchGoAccountRows,
  fetchGoAccountRow,
  assembleAccountList,
  assembleAccountListWithGo,
  assembleAccountRowWithGo,
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

// --- 单账号装配（watch 增量事件 / 单账号响应） ---

function singleHost(response) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    getManagementAccount: async (ref) => {
      calls.push(ref);
      return response;
    }
  };
}

test('单账号：按 Node ref 取 Go 事实并装配', async () => {
  resetGoAccountRowsState();
  const host = singleHost({ ok: true, data: goRow({ account_ref: 'acct_node1', enabled: false }) });
  const row = await assembleAccountRowWithGo({ goCoreSync: host }, nodeRow());
  assert.deepEqual(host.calls, ['acct_node1']);
  assert.equal(row.status, 'down');
});

test('单账号：取不到 Go 事实时原样返回 Node 行', async () => {
  resetGoAccountRowsState();
  const rows = nodeRow();
  assert.deepEqual(await assembleAccountRowWithGo({}, rows), rows);
  assert.deepEqual(
    await assembleAccountRowWithGo({ goCoreSync: singleHost({ ok: false, errorCode: 'go_core_unavailable' }) }, rows),
    rows
  );
});

test('单账号：Go core 关闭时不发请求', async () => {
  resetGoAccountRowsState();
  const calls = [];
  const host = {
    isEnabled: () => false,
    getManagementAccount: async (ref) => {
      calls.push(ref);
      return { ok: true, data: goRow() };
    }
  };
  const row = await assembleAccountRowWithGo({ goCoreSync: host }, nodeRow());
  assert.equal(row.status, 'up');
  assert.deepEqual(calls, []);
});

test('单账号：一次失败进入冷却，后续调用不再打 Go', async () => {
  resetGoAccountRowsState();
  const calls = [];
  const host = {
    isEnabled: () => true,
    getManagementAccount: async (ref) => {
      calls.push(ref);
      return { ok: false, errorCode: 'go_core_unavailable' };
    }
  };
  await fetchGoAccountRow(host, 'acct_node1');
  const second = await fetchGoAccountRow(host, 'acct_node2');
  assert.equal(second.ok, false);
  assert.equal(second.errorCode, 'go_core_cooldown');
  assert.deepEqual(calls, ['acct_node1']);
});

test('单账号：404（账号不在 Go）不触发全局冷却，列表仍可装配', async () => {
  resetGoAccountRowsState();
  const host = {
    isEnabled: () => true,
    getManagementAccount: async () => ({ ok: false, status: 404, errorCode: 'account_not_found' }),
    listManagementAccounts: async () => ({ ok: true, data: [goRow()], page: null })
  };
  const missing = await fetchGoAccountRow(host, 'acct_gemini');
  assert.equal(missing.ok, false);
  const list = await fetchGoAccountRows(host);
  assert.equal(list.ok, true);
});

test('单账号：5xx 进入冷却，后续不再打 Go', async () => {
  resetGoAccountRowsState();
  const calls = [];
  const host = {
    isEnabled: () => true,
    getManagementAccount: async (ref) => {
      calls.push(ref);
      return { ok: false, status: 502, errorCode: 'http_502' };
    }
  };
  await fetchGoAccountRow(host, 'acct_node1');
  const second = await fetchGoAccountRow(host, 'acct_node2');
  assert.equal(second.errorCode, 'go_core_cooldown');
  assert.deepEqual(calls, ['acct_node1']);
});

// 账号页行来源切到 Go 读模型：Go 决定有哪些账号，Node 只补富化字段。
function webUiRow(overrides = {}) {
  return {
    provider: 'agy',
    accountRef: 'acct_go_agy',
    displayId: '1',
    enabled: true,
    status: '',
    displayName: '',
    configured: true,
    apiKeyMode: false,
    isDefault: false,
    remainingPct: 100,
    planType: 'oauth',
    email: '',
    updatedAt: 1794384838074,
    modelCount: 16,
    ...overrides
  };
}

test('Go 读模型：Go 独有账号（agy）进入列表，不再被丢掉', async () => {
  resetGoAccountRowsState();
  const host = {
    isEnabled: () => true,
    listWebUiAccounts: async () => ({ ok: true, data: { accounts: [webUiRow()] } })
  };
  const result = await assembleAccountListWithGo({ goCoreSync: host }, []);
  assert.equal(result.goAssembled, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accountRef, 'acct_go_agy');
  assert.equal(result.accounts[0].provider, 'agy');
  // Go 独有账号也要有中性运行态字段，前端不用区分 undefined。
  assert.equal(result.accounts[0].runtimeStatus, '');
  assert.equal(result.accounts[0].runtimeUntil, 0);
});

test('Go 读模型：Node 行保留 Node ref 与运行态富化字段', async () => {
  resetGoAccountRowsState();
  const node = nodeRow({
    accountRef: 'acct_node1',
    runtimeStatus: 'running',
    runtimeReason: 'busy',
    runtimeUntil: 123,
    quotaReason: 'exhausted',
    lastUsedAt: 456,
    zcodeRegion: 'zai'
  });
  const host = {
    isEnabled: () => true,
    listWebUiAccounts: async () => ({
      ok: true,
      data: { accounts: [webUiRow({ provider: 'codex', accountRef: 'acct_go1' })] }
    })
  };
  // Node 侧的 ref 与 Go 不同（静态 key 账号），按 Node→Go 映射对齐。
  const result = await assembleAccountListWithGo(
    { goCoreSync: host, goAccountRefFor: (ref) => (ref === 'acct_node1' ? 'acct_go1' : ref) },
    [node]
  );
  assert.equal(result.accounts.length, 1);
  const row = result.accounts[0];
  assert.equal(row.accountRef, 'acct_node1', '行引用必须回落 Node 键');
  assert.equal(row.runtimeStatus, 'running');
  assert.equal(row.runtimeReason, 'busy');
  assert.equal(row.runtimeUntil, 123);
  assert.equal(row.quotaReason, 'exhausted');
  assert.equal(row.zcodeRegion, 'zai');
  assert.equal(row.modelCount, 16, 'Go 独有字段照样透出');
});

test('Go 读模型：Go 没有的 Node 账号原样保留', async () => {
  resetGoAccountRowsState();
  const node = nodeRow({ provider: 'gemini', accountRef: 'acct_gemini' });
  const host = {
    isEnabled: () => true,
    listWebUiAccounts: async () => ({ ok: true, data: { accounts: [webUiRow()] } })
  };
  const result = await assembleAccountListWithGo({ goCoreSync: host }, [node]);
  const refs = result.accounts.map((row) => row.accountRef).sort();
  assert.deepEqual(refs, ['acct_gemini', 'acct_go_agy']);
});

test('Go 读模型不可用：退回 Node 行（账号页照常可用）', async () => {
  resetGoAccountRowsState();
  const node = nodeRow();
  const host = {
    isEnabled: () => true,
    listWebUiAccounts: async () => ({ ok: false, status: 502, errorCode: 'http_502' }),
    listManagementAccounts: async () => ({ ok: false, status: 502, errorCode: 'http_502' })
  };
  const result = await assembleAccountListWithGo({ goCoreSync: host }, [node]);
  assert.equal(result.goAssembled, false);
  assert.deepEqual(result.accounts, [node]);
});

// Go 读模型的 status 恒为空串；空串会被前端当成 up，停用账号不能因此显示成正常。
test('Go 读模型：status 空串按 Node 结论 / Go enabled 补齐', async () => {
  resetGoAccountRowsState();
  const disabledNode = nodeRow({ accountRef: 'acct_node1', status: 'down' });
  const host = {
    isEnabled: () => true,
    listWebUiAccounts: async () => ({
      ok: true,
      data: {
        accounts: [
          webUiRow({ provider: 'codex', accountRef: 'acct_go1' }),
          webUiRow({ provider: 'cline', accountRef: 'acct_go2', enabled: false })
        ]
      }
    })
  };
  const result = await assembleAccountListWithGo(
    { goCoreSync: host, goAccountRefFor: (ref) => (ref === 'acct_node1' ? 'acct_go1' : ref) },
    [disabledNode]
  );
  const byRef = new Map(result.accounts.map((row) => [row.accountRef, row]));
  assert.equal(byRef.get('acct_node1').status, 'down', 'Node 结论优先');
  assert.equal(byRef.get('acct_go2').status, 'down', 'Go 独有账号按 enabled=false 判停用');
});
