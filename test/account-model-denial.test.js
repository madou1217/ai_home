'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TTL_MS,
  clearAccountModelDenials,
  isModelDeniedForAccount,
  markModelDeniedForAccount,
  resetAccountModelDenialRegistry,
  snapshotAccountModelDenials,
  subtractDeniedModels
} = require('../lib/server/account-model-denial');

const REF_A = 'acct_aaaaaaaaaaaaaaaaaaaa';
const REF_B = 'acct_bbbbbbbbbbbbbbbbbbbb';

test('records and reads back an account-level model denial', (t) => {
  t.after(resetAccountModelDenialRegistry);
  resetAccountModelDenialRegistry();

  assert.equal(isModelDeniedForAccount(REF_A, 'gemini-3.5-flash'), false);
  markModelDeniedForAccount(REF_A, 'gemini-3.5-flash');
  assert.equal(isModelDeniedForAccount(REF_A, 'gemini-3.5-flash'), true);
  // 大小写/空白归一：同一事实的不同写法不该各记一份。
  assert.equal(isModelDeniedForAccount(REF_A, ' Gemini-3.5-Flash '), true);
  // **账号级**：同 provider 的另一个账号不受影响（档位是账号属性，pro 号可能就能用）。
  assert.equal(isModelDeniedForAccount(REF_B, 'gemini-3.5-flash'), false);
  // 同一账号的其它模型不受影响。
  assert.equal(isModelDeniedForAccount(REF_A, 'gpt-5.5'), false);
});

test('the denial expires so an upgraded account recovers on its own', (t) => {
  t.after(resetAccountModelDenialRegistry);
  resetAccountModelDenialRegistry();
  const now = 1_000_000;

  markModelDeniedForAccount(REF_A, 'gemini-3.5-flash', { now, ttlMs: 60_000 });
  assert.equal(isModelDeniedForAccount(REF_A, 'gemini-3.5-flash', now + 59_999), true);
  assert.equal(isModelDeniedForAccount(REF_A, 'gemini-3.5-flash', now + 60_001), false);
});

// 目录净化：探测说「上游列了它」，实测说「这份账号用不了」—— 后者更硬。
// 用户原话：「为什么上游模型消失了没有同步处理」。
test('subtractDeniedModels drops only the denied models of that account', (t) => {
  t.after(resetAccountModelDenialRegistry);
  resetAccountModelDenialRegistry();
  markModelDeniedForAccount(REF_A, 'gemini-3.5-flash');

  const catalog = ['gemini-3.5-flash', 'gemini-3.5-flash-low', 'gpt-5.5'];
  assert.deepEqual(subtractDeniedModels(REF_A, catalog), ['gemini-3.5-flash-low', 'gpt-5.5']);
  // 别的账号原样返回（未被拒）。
  assert.deepEqual(subtractDeniedModels(REF_B, catalog), catalog);
  // 空输入 / 无记录时零开销原样返回。
  assert.deepEqual(subtractDeniedModels(REF_A, []), []);
  assert.deepEqual(subtractDeniedModels('', catalog), catalog);
});

test('clearing an account drops only that account', (t) => {
  t.after(resetAccountModelDenialRegistry);
  resetAccountModelDenialRegistry();
  markModelDeniedForAccount(REF_A, 'm');
  markModelDeniedForAccount(REF_B, 'm');
  clearAccountModelDenials(REF_A);
  assert.equal(isModelDeniedForAccount(REF_A, 'm'), false);
  assert.equal(isModelDeniedForAccount(REF_B, 'm'), true);
});

test('empty inputs are ignored and the TTL is 30 minutes', (t) => {
  t.after(resetAccountModelDenialRegistry);
  resetAccountModelDenialRegistry();
  markModelDeniedForAccount('', 'm');
  markModelDeniedForAccount(REF_A, '');
  assert.deepEqual(snapshotAccountModelDenials(), {});
  assert.equal(DEFAULT_TTL_MS, 30 * 60 * 1000);
});
