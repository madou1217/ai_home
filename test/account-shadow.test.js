'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareAccountSets } = require('../lib/server/account-shadow');

function nodeRow(overrides = {}) {
  return { accountRef: 'acct_a', provider: 'codex', status: 'up', ...overrides };
}

function goRow(overrides = {}) {
  return { account_ref: 'acct_a', provider_id: 'codex', enabled: true, ...overrides };
}

test('完全一致时 equal', () => {
  const diff = compareAccountSets([nodeRow()], [goRow()], null);
  assert.equal(diff.equal, true);
  assert.equal(diff.nodeCount, 1);
  assert.equal(diff.goCount, 1);
});

test('仅 Node 有 / 仅 Go 有 分开报（Node-only Provider 要能看见）', () => {
  const diff = compareAccountSets(
    [nodeRow({ accountRef: 'acct_gemini', provider: 'gemini' })],
    [goRow({ account_ref: 'acct_go', provider_id: 'codex' })],
    null
  );
  assert.deepEqual(diff.nodeOnly.map((row) => row.accountRef), ['acct_gemini']);
  assert.deepEqual(diff.goOnly.map((row) => row.accountRef), ['acct_go']);
  assert.equal(diff.equal, false);
});

test('provider 不一致要单独列出', () => {
  const diff = compareAccountSets(
    [nodeRow({ provider: 'claude' })],
    [goRow({ provider_id: 'codex' })],
    null
  );
  assert.equal(diff.providerMismatch.length, 1);
  assert.equal(diff.equal, false);
});

test('Node 的 down 等价于 Go 的 enabled=false', () => {
  const diff = compareAccountSets(
    [nodeRow({ status: 'down' })],
    [goRow({ enabled: false })],
    null
  );
  assert.deepEqual(diff.enabledMismatch, []);
  assert.equal(diff.equal, true);
});

test('enabled 不一致要列出', () => {
  const diff = compareAccountSets(
    [nodeRow({ status: 'up' })],
    [goRow({ enabled: false })],
    null
  );
  assert.equal(diff.enabledMismatch.length, 1);
});

test('accountRef 翻译函数生效', () => {
  const diff = compareAccountSets(
    [nodeRow({ accountRef: 'acct_node' })],
    [goRow({ account_ref: 'acct_go' })],
    (ref) => (ref === 'acct_node' ? 'acct_go' : ref)
  );
  assert.equal(diff.equal, true);
});

//
// Vertex 占位账号在 Go 侧被刻意置为 disabled（见 go-account-sync 的 enabled 计算），
// 不能算作分歧。
test('vertex 占位账号的 enabled 差异被忽略', () => {
  const diff = compareAccountSets(
    [nodeRow({ provider: 'gemini', status: 'up' })],
    [goRow({ provider_id: 'gemini', enabled: false, auth_kind: 'vertex_ai' })],
    null
  );
  assert.deepEqual(diff.enabledMismatch, []);
  assert.equal(diff.equal, true);
});
