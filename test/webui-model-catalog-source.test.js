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

test('Go 成功覆盖后旧 firstError 不再残留', () => {
  const local = localResult();
  local.firstError = 'go_model_catalog_unavailable:go_model_catalog_reader_missing';
  const merged = mergeGoCatalogResult(local, {
    updatedAt: 2000,
    byAccount: { acct_a: ['go-model-1'], acct_b: ['go-model-b'] },
    errorsByAccount: {},
    source: 'remote'
  }, null);
  assert.equal(merged.firstError, '', 'Go 覆盖了出错的账号后，摘要必须重算');
  assert.deepEqual(merged.errorsByAccount, {});
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

test('Go ref 与 Node ref 不同：目录挂到 Node ref 上', () => {
  const merged = mergeGoCatalogResult(
    localResult(),
    { updatedAt: 2500, byAccount: { acct_go_other: ['go-1', 'go-2'] }, errorsByAccount: {} },
    null,
    (goRef) => (goRef === 'acct_go_other' ? 'acct_a' : '')
  );
  // 页面只认 Node ref：挂到 acct_a 才能被 buildCatalogModelEntries 用上。
  assert.deepEqual(merged.byAccount.acct_a, ['go-1', 'go-2']);
  assert.equal(merged.byAccount.acct_go_other, undefined);
});

test('映射不到 Node ref 的 Go 账号直接跳过', () => {
  const merged = mergeGoCatalogResult(
    localResult(),
    { byAccount: { acct_unknown: ['x'] }, errorsByAccount: {} },
    null,
    () => ''
  );
  assert.deepEqual(merged.byAccount, localResult().byAccount);
});

test('ref 翻译后再按 Node 作用域过滤', () => {
  const merged = mergeGoCatalogResult(
    localResult(),
    { byAccount: { acct_go_a: ['go-a'], acct_go_b: ['go-b'] }, errorsByAccount: {} },
    { accountRef: 'acct_a' },
    (goRef) => (goRef === 'acct_go_a' ? 'acct_a' : 'acct_b')
  );
  assert.deepEqual(merged.byAccount.acct_a, ['go-a']);
  assert.deepEqual(merged.byAccount.acct_b, ['b-model']);
});

test('探测时刻与错误以 Go 为准（错误清空也要同步）', () => {
  const merged = mergeGoCatalogResult(
    {
      ...localResult(),
      errorsByAccount: { acct_a: 'old_failure' },
      accountProbedAt: { acct_a: 100 }
    },
    {
      updatedAt: 3000,
      byAccount: { acct_go_a: ['m1'] },
      errorsByAccount: {},
      accountProbedAt: { acct_go_a: 2000 }
    },
    null,
    (goRef) => (goRef === 'acct_go_a' ? 'acct_a' : '')
  );
  assert.equal(merged.accountProbedAt.acct_a, 2000);
  // Go 这次成功（无错误）→ 旧错误必须清掉，否则页面一直显示失败。
  assert.equal(merged.errorsByAccount.acct_a, undefined);
});
