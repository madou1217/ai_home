'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoModelCatalogReader } = require('../lib/server/go-model-catalog-reader');

const NOW = 1790000000000;

function managementResponse(accounts, meta = {}) {
  return {
    ok: true,
    status: 200,
    data: accounts,
    body: { data: accounts, ...meta }
  };
}

function rawResponse(accounts, meta = {}) {
  return { data: accounts, ...meta };
}

test('正常映射：byAccount / accountSource / updatedAt / 错误与探测时刻', async () => {
  const accounts = [
    {
      account_ref: 'acct_a',
      provider_id: 'opencode',
      last_attempt_at_ms: NOW - 100,
      last_success_at_ms: NOW - 100,
      last_source: 'remote',
      models: [
        { model_id: 'opencode/z', updated_at_ms: NOW - 100 },
        { model_id: 'opencode/a', updated_at_ms: NOW - 100 },
        { model_id: 'opencode/z', updated_at_ms: NOW - 100 }
      ]
    },
    {
      account_ref: 'acct_b',
      provider_id: 'zcode',
      last_attempt_at_ms: NOW - 50,
      last_success_at_ms: NOW - 50,
      last_source: 'local',
      models: [{ model_id: 'glm-5.3' }]
    },
    {
      account_ref: 'acct_c',
      provider_id: 'cline',
      last_attempt_at_ms: NOW - 25,
      last_success_at_ms: NOW - 25,
      last_error_code: 'zcode_empty_catalog',
      last_error_message: 'zcode 模型目录为空',
      models: []
    }
  ];
  let captured = null;
  const reader = createGoModelCatalogReader({
    now: () => NOW,
    call: async (method, path) => {
      captured = { method, path };
      return managementResponse(accounts, { generation: 7, updated_at_ms: NOW - 10 });
    }
  });

  const result = await reader.read();

  assert.equal(captured.method, 'GET');
  assert.equal(captured.path, '/v1/management/account-models');
  assert.deepEqual(result.byAccount, {
    acct_a: ['opencode/a', 'opencode/z'],
    acct_b: ['glm-5.3'],
    acct_c: []
  });
  assert.deepEqual(result.accountSource, {
    acct_a: 'remote',
    acct_b: 'local',
    acct_c: 'error'
  });
  assert.deepEqual(result.models, {
    opencode: ['opencode/a', 'opencode/z'],
    zcode: ['glm-5.3']
  });
  assert.equal(result.updatedAt, NOW - 10);
  assert.equal(result.generation, 7);
  assert.equal(result.cached, true);
  assert.equal(result.scannedAccounts, 3);
  assert.deepEqual(result.accountProbedAt, {
    acct_a: NOW - 100,
    acct_b: NOW - 50,
    acct_c: NOW - 25
  });
  assert.deepEqual(result.errorsByAccount, { acct_c: 'zcode 模型目录为空' });
  assert.equal(result.firstError, 'zcode 模型目录为空');
  assert.equal(result.source, 'remote');
  assert.equal(result.sourceCount, 2);
  assert.deepEqual(result.labels, {});
});

test('空数据：返回空结果，不是失败', async () => {
  const reader = createGoModelCatalogReader({
    now: () => NOW,
    call: async () => managementResponse([], { generation: 9, updated_at_ms: 12345 })
  });

  const result = await reader.read();

  assert.notEqual(result, null);
  assert.deepEqual(result.byAccount, {});
  assert.deepEqual(result.accountSource, {});
  assert.deepEqual(result.models, {});
  assert.equal(result.updatedAt, 12345);
  assert.equal(result.generation, 9);
  assert.equal(result.source, 'empty');
  assert.equal(result.sourceCount, 0);
  assert.equal(result.scannedAccounts, 0);
  assert.equal(result.firstError, '');
  assert.deepEqual(result.errorsByAccount, {});
  assert.deepEqual(result.accountProbedAt, {});
});

test('直接 JSON：updatedAt 回退到模型最大 updated_at_ms', async () => {
  const reader = createGoModelCatalogReader({
    now: () => NOW,
    call: async () => rawResponse([
      {
        account_ref: 'acct_a',
        provider_id: 'codex',
        models: [{ model_id: 'gpt-6', updated_at_ms: NOW - 20 }]
      }
    ], { generation: 3 })
  });

  const result = await reader.read();

  assert.equal(result.updatedAt, NOW - 20);
  assert.equal(result.generation, 3);
  assert.deepEqual(result.byAccount, { acct_a: ['gpt-6'] });
});

test('503 / 网络失败 / 无效 payload 返回 null', async () => {
  const cases = [
    {
      name: '503',
      call: async () => ({ ok: false, status: 503, data: null, errorCode: 'http_503' })
    },
    {
      name: 'status 503 但 ok=true',
      call: async () => ({ ok: true, status: 503, data: [] })
    },
    {
      name: '网络异常',
      call: async () => { throw new Error('network down'); }
    },
    {
      name: 'null 响应',
      call: async () => null
    },
    {
      name: '缺少 data',
      call: async () => ({ ok: true, status: 200 })
    }
  ];
  for (const item of cases) {
    const reader = createGoModelCatalogReader({ call: item.call, now: () => NOW });
    assert.equal(await reader.read(), null, item.name);
  }
});

test('provider/account 过滤参数透传，accountRef 去重', async () => {
  let captured = null;
  const reader = createGoModelCatalogReader({
    now: () => NOW,
    call: async (method, path) => {
      captured = { method, path };
      return managementResponse([], { updated_at_ms: 1 });
    }
  });

  await reader.read({
    provider: 'opencode',
    accountRef: 'acct_a',
    accountRefs: ['acct_b', 'acct_a'],
    afterRef: 'acct_0',
    limit: 50
  });

  const url = new URL(captured.path, 'http://127.0.0.1');
  assert.equal(url.pathname, '/v1/management/account-models');
  assert.equal(url.searchParams.get('provider'), 'opencode');
  assert.deepEqual(url.searchParams.getAll('account_ref'), ['acct_a', 'acct_b']);
  assert.equal(url.searchParams.get('after_ref'), 'acct_0');
  assert.equal(url.searchParams.get('limit'), '50');

  await reader.read();
  assert.equal(captured.path, '/v1/management/account-models');
});

test('缺少 last_source 时按模型推导 source', async () => {
  const reader = createGoModelCatalogReader({
    now: () => NOW,
    call: async () => managementResponse([
      {
        account_ref: 'acct_a',
        provider_id: 'codex',
        models: [{ model_id: 'gpt-6' }]
      },
      {
        account_ref: 'acct_b',
        provider_id: 'codex',
        last_success_at_ms: NOW - 5,
        models: []
      },
      {
        account_ref: 'acct_c',
        provider_id: 'codex',
        last_source: 'remote',
        last_success_at_ms: NOW - 5,
        models: []
      }
    ])
  });

  const result = await reader.read();

  assert.deepEqual(result.accountSource, {
    acct_a: 'remote',
    acct_b: 'empty',
    acct_c: 'empty'
  });
});
