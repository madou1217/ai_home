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

test('auth_mode 两侧都有值时比较', () => {
  const diff = compareAccountSets(
    [nodeRow({ authMode: 'oauth' })],
    [goRow({ auth_mode: 'api_key' })],
    null
  );
  assert.deepEqual(diff.fieldMismatch, [
    { accountRef: 'acct_a', field: 'auth_mode', node: 'oauth', go: 'api_key' }
  ]);
  assert.equal(diff.equal, false);

  // 一侧为空视为「无法判定」，不报差异（Go 未写凭据形态时不该刷屏）。
  const skipped = compareAccountSets([nodeRow({ authMode: 'oauth' })], [goRow()], null);
  assert.deepEqual(skipped.fieldMismatch, []);
  assert.equal(skipped.equal, true);
});

test('额度快照的有无与采集时间要一致', () => {
  const missing = compareAccountSets(
    [nodeRow({ usageSnapshot: { capturedAt: 1730000000000, entries: [] } })],
    [goRow()],
    null
  );
  assert.deepEqual(missing.fieldMismatch, [
    { accountRef: 'acct_a', field: 'usage_snapshot', node: 'present', go: 'missing' }
  ]);

  const stale = compareAccountSets(
    [nodeRow({ usageSnapshot: { capturedAt: 1730000000000 } })],
    [goRow({ usage_snapshot: { captured_at: '2026-11-06T02:00:00Z' } })],
    null
  );
  assert.equal(stale.fieldMismatch.length, 1);
  assert.equal(stale.fieldMismatch[0].field, 'usage_captured_at');
});

test('快照采集时间在 1 秒内视为同一份', () => {
  const diff = compareAccountSets(
    [nodeRow({ usageSnapshot: { capturedAt: 1730000000000 } })],
    [goRow({ usage_snapshot: { captured_at: new Date(1730000000500).toISOString() } })],
    null
  );
  assert.deepEqual(diff.fieldMismatch, []);
  assert.equal(diff.equal, true);
});

test('两侧都没有快照时不报差异', () => {
  const diff = compareAccountSets([nodeRow()], [goRow()], null);
  assert.deepEqual(diff.fieldMismatch, []);
});
