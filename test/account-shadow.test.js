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

test('鉴权字段不按字面比较（Node 与 Go 是两套词表）', () => {
  // Node authMode=oauth / api-key，Go auth_kind=oauth|api_key / auth_mode=''|consumer；
  // 直接比会每轮都假警（实测 opencode 在 Go 是 api_key，在 Node 却不是 apiKeyMode）。
  const diff = compareAccountSets(
    [nodeRow({ authMode: 'oauth', apiKeyMode: false })],
    [goRow({ auth_mode: 'consumer', auth_kind: 'oauth' })],
    null
  );
  assert.deepEqual(diff.fieldMismatch, []);
  assert.equal(diff.equal, true);
});

test('身份字段只在 Go 有值时比较', () => {
  const diff = compareAccountSets(
    [nodeRow({ displayName: 'Node 名' })],
    [goRow({ display_name: 'Go 名' })],
    null
  );
  assert.deepEqual(diff.fieldMismatch, [
    { accountRef: 'acct_a', field: 'displayName', node: 'Node 名', go: 'Go 名' }
  ]);
  assert.equal(diff.equal, false);

  // Go 的 account_profiles 目前为空：这是缺口不是漂移。
  const skipped = compareAccountSets([nodeRow()], [goRow({ display_name: '' })], null);
  assert.deepEqual(skipped.fieldMismatch, []);
  assert.equal(skipped.equal, true);
});

test('Node 快照比 Go 新才算漂移（Go 更新是采集时延）', () => {
  // Node 比 Go 新 10 分钟：Node 还在自己产出快照，翻页后会丢数据。
  const nodeAhead = compareAccountSets(
    [nodeRow({ usageSnapshot: { capturedAt: 1730000600000 } })],
    [goRow({ usage_snapshot: { captured_at: new Date(1730000000000).toISOString() } })],
    null
  );
  assert.equal(nodeAhead.fieldMismatch.length, 1);
  assert.equal(nodeAhead.fieldMismatch[0].field, 'usageSnapshot.capturedAt');

  // Go 比 Node 新 4 分钟：Go 在持续采集，Node 等下一轮同步，不是差异。
  const goAhead = compareAccountSets(
    [nodeRow({ usageSnapshot: { capturedAt: 1730000000000 } })],
    [goRow({ usage_snapshot: { captured_at: new Date(1730000240000).toISOString() } })],
    null
  );
  assert.deepEqual(goAhead.fieldMismatch, []);
  assert.equal(goAhead.equal, true);
});

test('只有一侧有快照不算差异（展示口径不同 / Node 遗留缓存）', () => {
  const nodeOnly = compareAccountSets(
    [nodeRow({ usageSnapshot: { capturedAt: 1730000000000 } })],
    [goRow()],
    null
  );
  assert.deepEqual(nodeOnly.fieldMismatch, []);
  assert.equal(nodeOnly.equal, true);

  const goOnly = compareAccountSets([nodeRow()], [goRow({ usage_snapshot: { captured_at: '2026-11-06T02:00:00Z' } })], null);
  assert.deepEqual(goOnly.fieldMismatch, []);
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
