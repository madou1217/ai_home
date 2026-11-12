'use strict';

// 回归守卫：Go 接管的 Provider 必须在模型探测选项里拿到 account_models 读取器。
//
// 2026-11-05 事故：server.js 的 fetchModelsForAccountWithRefresh 漏了最后一跳注入，
// 所有 Go 接管 Provider 都以 go_model_catalog_reader_missing 失败，
// /v0/management/models 从 178 个模型变成 0（WebUI 因为合并层不走这条路，看不出来）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { withGoModelSource } = require('../lib/server/go-model-source-options');

test('注入 Go 读取器与 ref 翻译，且不改动入参', () => {
  const calls = [];
  const host = {
    listAccountModels: async (path) => {
      calls.push(path);
      return { ok: true, status: 200, data: [] };
    },
    goAccountRefFor: (ref) => 'go:' + ref
  };
  const options = { fs: {}, aiHomeDir: '/tmp/x' };
  const next = withGoModelSource(options, host);
  assert.notEqual(next, options, '必须返回新对象，避免污染调用方选项');
  assert.equal(typeof next.goAccountModels, 'function');
  assert.equal(next.goAccountRefFor('acct_a'), 'go:acct_a');
  assert.equal(options.goAccountModels, undefined);
  assert.equal(next.fs, options.fs);
  void next.goAccountModels('/v1/management/account-models');
  assert.deepEqual(calls, ['/v1/management/account-models']);
});

test('Go core 不可用时原样返回（由策略层报 reader_missing，而不是崩溃）', () => {
  const options = { aiHomeDir: '/tmp/x' };
  assert.equal(withGoModelSource(options, null), options);
  assert.equal(withGoModelSource(options, {}), options);
});

test('Host 没有 ref 翻译时按恒等返回', () => {
  const host = { listAccountModels: async () => ({ ok: true, status: 200, data: [] }) };
  const next = withGoModelSource({}, host);
  assert.equal(next.goAccountRefFor('acct_same'), 'acct_same');
});
