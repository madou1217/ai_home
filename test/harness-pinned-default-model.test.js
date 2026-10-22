'use strict';

// 外部 harness 的「钉选账号默认模型」解析：没指定模型时不能让用户一启动就撞 503。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePinnedHarnessDefaultModel } = require('../lib/harness/pinned-default-model');

// accountRef 形状受 isAccountRef 校验（真实 ref 是 acct_ + 20 位），用短串会被
// 设置存储整条丢弃，测的就不是这里的分支了。
const ACCOUNT_REF = 'acct_2b2f6702db12593c19cf';

function resolve(overrides = {}) {
  return resolvePinnedHarnessDefaultModel({
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    readModelsCache: () => ({ byAccount: { [ACCOUNT_REF]: ['gpt-a', 'gpt-b'] } }),
    readSettings: () => ({ accountModels: [] }),
    ...overrides
  });
}

test('没有钉选账号时不猜默认模型', () => {
  assert.equal(resolve({ accountRef: '' }), '');
  assert.equal(resolve({ accountRef: '   ' }), '');
});

test('取该账号目录里的第一条模型', () => {
  assert.equal(resolve(), 'gpt-a');
});

test('用户给该账号配了默认模型时优先用它', () => {
  const value = resolve({
    readSettings: () => ({
      accountModels: [{ accountRef: ACCOUNT_REF, id: 'gpt-b', defaultModel: true, enabled: true }]
    })
  });
  assert.equal(value, 'gpt-b');
});

test('配的默认模型不在该账号目录里时退回目录第一条', () => {
  const value = resolve({
    readSettings: () => ({
      accountModels: [{ accountRef: ACCOUNT_REF, id: 'gpt-missing', defaultModel: true, enabled: true }]
    })
  });
  assert.equal(value, 'gpt-a');
});

test('账号目录为空或没有该账号时不猜', () => {
  assert.equal(resolve({ readModelsCache: () => ({ byAccount: {} }) }), '');
  assert.equal(resolve({ readModelsCache: () => ({ byAccount: { [ACCOUNT_REF]: [] } }) }), '');
  assert.equal(resolve({ readModelsCache: () => null }), '');
});

test('目录或设置读取失败时降级成空串，不抛出', () => {
  assert.equal(resolve({ readModelsCache: () => { throw new Error('db locked'); } }), '');
  assert.equal(resolve({ readSettings: () => { throw new Error('db locked'); } }), 'gpt-a');
});
