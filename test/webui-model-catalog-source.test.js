'use strict';

// WebUI 模型目录合并层：Go account_models 覆盖 byAccount，其余字段保留 Node 的。
//
// 这一层是「切读」的安全边界：Go 读不到、或显式刷新刚探测完时都必须原样返回 Node 结果，
// 否则页面会出现空目录/旧目录。

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGoCatalogResult } = require('../lib/server/webui-model-catalog-source');

function localResult() {
  return {
    cached: true,
    updatedAt: 1000,
    source: 'local',
    sourceCount: 1,
    scannedAccounts: 2,
    firstError: '',
    models: { codex: ['gpt-5'] },
    byAccount: { acct_a: ['local-model'], acct_b: ['b-model'] },
    errorsByAccount: { acct_b: 'probe_failed' },
    accountProbedAt: { acct_a: 900, acct_b: 950 },
    labels: { Auto: 'Auto' }
  };
}

function remoteResult() {
  return {
    updatedAt: 2000,
    byAccount: { acct_a: ['go-model-1', 'go-model-2'] },
    errorsByAccount: {},
    source: 'remote'
  };
}

test('Go 有数据时覆盖 byAccount，保留 Node 的探测时刻/标签/路由证据', () => {
  const merged = mergeGoCatalogResult(localResult(), remoteResult(), null);
  assert.deepEqual(merged.byAccount.acct_a, ['go-model-1', 'go-model-2']);
  // Go 没有的账号继续用 Node 的目录，不清空。
  assert.deepEqual(merged.byAccount.acct_b, ['b-model']);
  assert.deepEqual(merged.models, { codex: ['gpt-5'] });
  assert.deepEqual(merged.accountProbedAt, { acct_a: 900, acct_b: 950 });
  assert.deepEqual(merged.labels, { Auto: 'Auto' });
  assert.equal(merged.updatedAt, 2000);
  assert.equal(merged.source, 'remote');
});

test('账号作用域只覆盖目标账号', () => {
  const merged = mergeGoCatalogResult(localResult(), {
    ...remoteResult(),
    byAccount: { acct_a: ['go-a'], acct_b: ['go-b'] }
  }, { accountRef: 'acct_a' });
  assert.deepEqual(merged.byAccount.acct_a, ['go-a']);
  assert.deepEqual(merged.byAccount.acct_b, ['b-model']);
});

test('Go 空目录或全被作用域过滤时保持 Node 结果', () => {
  assert.deepEqual(
    mergeGoCatalogResult(localResult(), { byAccount: {} }, null).byAccount,
    localResult().byAccount
  );
  const filtered = mergeGoCatalogResult(localResult(), {
    ...remoteResult(),
    byAccount: { acct_other: ['x'] }
  }, { accountRef: 'acct_a' });
  assert.deepEqual(filtered.byAccount, localResult().byAccount);
});

test('Go 目录全为空数组时来源不升级为 remote', () => {
  const merged = mergeGoCatalogResult(localResult(), {
    updatedAt: 3000,
    byAccount: { acct_a: [] },
    errorsByAccount: { acct_a: 'empty_catalog' }
  }, null);
  assert.deepEqual(merged.byAccount.acct_a, []);
  assert.equal(merged.source, 'local');
  assert.equal(merged.errorsByAccount.acct_a, 'empty_catalog');
});
