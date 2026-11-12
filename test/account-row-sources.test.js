'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_ROW_FIELDS,
  GO_ASSEMBLED_FIELDS,
  assembleAccountRow,
  diffAccountRow,
  countFallbacks
} = require('../lib/server/account-row-sources');

// 线上 /v0/webui/accounts 的完整字段集（2026-11-06 抓 43 行取并集）。
// 这张名单是契约：来源表漏一个字段，装配器就会静默丢一列。
const LIVE_ROW_FIELDS = [
  'provider', 'accountRef', 'status', 'displayName', 'configured', 'apiKeyMode',
  'isDefault', 'isMobile', 'remainingPct', 'usageSnapshot', 'upstreamErrorRules',
  'upstreamErrorGroupIds', 'updatedAt', 'planType', 'email', 'displayNames',
  'tokenUsage', 'authMode', 'authPending', 'authPendingStale', 'authPendingAgeMs',
  'baseUrl', 'customUpstream', 'windowActivationSupported', 'aliasPoolParticipates',
  'activityActions', 'gatewayTargetSupported', 'quotaStatus', 'schedulableStatus',
  'lastUsedAt', 'runtimeStatus', 'runtimeUntil', 'runtimeReason', 'schedulableReason',
  'planName', 'loginType', 'zcodeRegion', 'quotaReason', 'runtimeModels'
];

function nodeRow(overrides = {}) {
  return {
    provider: 'codex',
    accountRef: 'acct_node1',
    status: 'up',
    displayName: 'proxy.meadeo.com',
    configured: true,
    apiKeyMode: true,
    isDefault: true,
    isMobile: false,
    remainingPct: 42.5,
    usageSnapshot: { capturedAt: 1730000000000, entries: [] },
    upstreamErrorRules: [],
    upstreamErrorGroupIds: [],
    updatedAt: 1793931552597,
    planType: 'api-key',
    email: 'me@example.com',
    displayNames: [{ type: 'name', value: 'proxy.meadeo.com' }],
    tokenUsage: { day: 1, week: 2, month: 3, total: 4, models: [] },
    authMode: 'api-key',
    authPending: false,
    authPendingStale: false,
    authPendingAgeMs: 0,
    baseUrl: 'https://proxy.meadeo.com/v1',
    customUpstream: true,
    windowActivationSupported: false,
    aliasPoolParticipates: true,
    activityActions: [],
    gatewayTargetSupported: true,
    quotaStatus: 'available',
    schedulableStatus: 'schedulable',
    lastUsedAt: 1793931514134,
    runtimeStatus: 'healthy',
    runtimeUntil: 0,
    runtimeReason: '',
    schedulableReason: '',
    planName: '',
    loginType: '',
    zcodeRegion: '',
    quotaReason: '',
    runtimeModels: [],
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
    auth_kind: 'api_key',
    auth_mode: '',
    ...overrides
  };
}

test('来源表覆盖线上全部字段，且没有多余字段', () => {
  const declared = ACCOUNT_ROW_FIELDS.map((entry) => entry.field);
  assert.deepEqual([...declared].sort(), [...LIVE_ROW_FIELDS].sort());
  assert.equal(new Set(declared).size, declared.length, '字段不能重复登记');
});

test('Go 与 Node 一致时装配结果逐字段相同（零差异）', () => {
  const node = nodeRow();
  const assembled = assembleAccountRow(node, goRow());
  assert.deepEqual(assembled, node);
});

test('Go 有值且与 Node 不同时以 Go 为准', () => {
  const assembled = assembleAccountRow(nodeRow(), goRow({
    enabled: false,
    has_credential: false,
    display_name: 'Go 显示名',
    email: 'go@example.com',
    subscription_kind: 'pro'
  }));
  assert.equal(assembled.status, 'down');
  assert.equal(assembled.configured, false);
  assert.equal(assembled.displayName, 'Go 显示名');
  assert.equal(assembled.email, 'go@example.com');
  assert.equal(assembled.planType, 'pro');
});

test('Go 没写身份字段时保留 Node 值（account_profiles 目前为空）', () => {
  const node = nodeRow();
  const assembled = assembleAccountRow(node, goRow({ display_name: '', email: '', subscription_kind: '' }));
  assert.equal(assembled.displayName, node.displayName);
  assert.equal(assembled.email, node.email);
  assert.equal(assembled.planType, node.planType);
  assert.deepEqual(countFallbacks(goRow({ display_name: '', email: '', subscription_kind: '' })),
    ['displayName', 'isDefault', 'planType', 'email']);
});

test('Vertex 占位账号的 status 不被 Go 的 enabled=false 覆盖', () => {
  const node = nodeRow({ provider: 'gemini', status: 'up' });
  const assembled = assembleAccountRow(node, goRow({
    provider_id: 'gemini', enabled: false, auth_kind: 'vertex_ai'
  }));
  assert.equal(assembled.status, 'up');
});

test('Go 视图缺失时装配结果与 Node 行完全一致', () => {
  const node = nodeRow();
  assert.deepEqual(assembleAccountRow(node, null), node);
  assert.deepEqual(assembleAccountRow(node, undefined), node);
});

test('对拍能逐字段报出差异', () => {
  const diffs = diffAccountRow(nodeRow({ status: 'down' }), goRow({ enabled: true }));
  assert.deepEqual(diffs, [{ field: 'status', node: 'down', go: 'up' }]);

  const identity = diffAccountRow(nodeRow({ displayName: 'A' }), goRow({ display_name: 'B' }));
  assert.deepEqual(identity, [{ field: 'displayName', node: 'A', go: 'B' }]);
});

test('对拍不把 Go 的空值当差异（那是缺口不是漂移）', () => {
  const diffs = diffAccountRow(nodeRow(), goRow({ display_name: '', email: '', subscription_kind: '' }));
  assert.deepEqual(diffs, []);
});

test('对拍不比较 Node 独有字段与词汇不同的鉴权字段', () => {
  // authMode 在两侧是两套词表（api-key vs api_key/native_auth_json），比了只会假警。
  const diffs = diffAccountRow(
    nodeRow({ authMode: 'api-key', apiKeyMode: true, updatedAt: 1 }),
    goRow({ auth_mode: '', auth_kind: 'api_key' })
  );
  assert.deepEqual(diffs, []);
});

test('go-projected 字段不参与 Go 视图覆盖（Node 已直读 Go 物化状态）', () => {
  const node = nodeRow({ remainingPct: 10, quotaStatus: 'exhausted' });
  const assembled = assembleAccountRow(node, goRow({ remaining_bps: 9000 }));
  assert.equal(assembled.remainingPct, 10);
  assert.equal(assembled.quotaStatus, 'exhausted');
  assert.ok(!GO_ASSEMBLED_FIELDS.some((entry) => entry.field === 'remainingPct'));
});

test('默认账号与额度状态以 Go 为准', () => {
  const node = nodeRow({ isDefault: false, quotaStatus: 'pending', quotaReason: '' });
  const assembled = assembleAccountRow(node, goRow({
    is_default: true,
    quota_status: 'exhausted',
    quota_reason: 'usage_exhausted'
  }));
  assert.equal(assembled.isDefault, true);
  // 额度状态是持续采集的字段，仍由 Node 渲染（见来源表注释）。
  assert.equal(assembled.quotaStatus, 'pending');
  assert.equal(assembled.quotaReason, '');

  // Go 没有额度状态时同样保留 Node（Node-only Provider 的账号）。
  const kept = assembleAccountRow(node, goRow({ is_default: false }));
  assert.equal(kept.quotaStatus, 'pending');
  assert.equal(kept.quotaReason, '');

  // Go 有状态但没有原因：不影响行形状。
  const cleared = assembleAccountRow(
    nodeRow({}),
    goRow({ quota_status: 'available', quota_reason: '' })
  );
  assert.equal(cleared.quotaReason, '');
});

test('每个字段都写明判定理由，且与 source 不矛盾', () => {
  const allowed = {
    go: 'go-fact',
    'go-projected': 'go-computed'
  };
  for (const entry of ACCOUNT_ROW_FIELDS) {
    assert.ok(entry.reason, entry.field + ' 缺少判定理由');
    if (allowed[entry.source]) {
      assert.equal(entry.reason, allowed[entry.source], entry.field + ' 的 source/reason 不一致');
    } else {
      assert.ok(String(entry.reason).startsWith('node-') || entry.reason === 'row-key' || entry.reason === 'credential-vocabulary',
        entry.field + ' 的 Node 判定理由不属于已知类别: ' + entry.reason);
    }
  }
});

test('来源分布：Go 判定 7 / Go 计算 4 / Node 独有 28', () => {
  const counts = {};
  for (const entry of ACCOUNT_ROW_FIELDS) counts[entry.source] = (counts[entry.source] || 0) + 1;
  assert.deepEqual(counts, { go: 7, 'go-projected': 4, node: 28 });
  const reasons = {};
  for (const entry of ACCOUNT_ROW_FIELDS) reasons[entry.reason] = (reasons[entry.reason] || 0) + 1;
  assert.deepEqual(reasons, {
    'go-fact': 7,
    'go-computed': 4,
    'row-key': 1,
    'credential-vocabulary': 3,
    'node-capability': 6,
    'node-config': 2,
    'node-state-time': 1,
    'node-derived-identity': 4,
    'node-usage': 1,
    'node-oauth': 3,
    'node-derived-state': 2,
    'node-runtime': 5
  });
});
