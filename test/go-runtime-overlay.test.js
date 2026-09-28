const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyGoRuntimeOverlay,
  createGoRuntimeOverlay
} = require('../lib/server/go-runtime-overlay');

const NOW = 1_790_000_000_000;

test('overlay projects Go rows onto linked Node refs, sharing one Go account across merged Node accounts', async () => {
  const overlay = createGoRuntimeOverlay({
    listAccountRuntime: async () => [
      { account_ref: 'go_1', blocks: ['credentials_updated'], last_failure_ms: NOW, last_failure_kind: 'credential_rejected' },
      { account_ref: 'go_unlinked', last_success_ms: NOW }
    ],
    readGoRefsByNodeRef: () => ({ node_a: 'go_1', node_b: 'go_1', node_c: 'go_2' })
  });
  await overlay.refresh();
  assert.equal(overlay.get('node_a').blocks[0], 'credentials_updated');
  assert.equal(overlay.get('node_b'), overlay.get('node_a'));
  assert.equal(overlay.get('node_c'), null);
  assert.equal(overlay.size(), 2, 'unlinked Go refs are ignored');
});

test('overlay uses Go refs as-is when account sync is off', async () => {
  const overlay = createGoRuntimeOverlay({
    listAccountRuntime: async () => [{ account_ref: 'acct_same', last_success_ms: NOW }],
    readGoRefsByNodeRef: () => null
  });
  await overlay.refresh();
  assert.equal(overlay.get('acct_same').lastSuccessAt, NOW);
});

test('Go outage, errors or timeouts leave an empty overlay instead of stale state', async (t) => {
  // 超时计时器是 unref 的（生产里由 server 保活）；测试里单独保活事件循环。
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let mode = 'ok';
  const overlay = createGoRuntimeOverlay({
    fetchTimeoutMs: 20,
    listAccountRuntime: () => {
      if (mode === 'ok') return Promise.resolve([{ account_ref: 'acct_1', blocks: ['usage_snapshot'] }]);
      if (mode === 'down') return Promise.resolve(null);
      if (mode === 'throw') return Promise.reject(new Error('boom'));
      return new Promise(() => {});
    }
  });
  for (const failure of ['down', 'throw', 'hang']) {
    mode = 'ok';
    await overlay.refresh();
    assert.ok(overlay.get('acct_1'));
    mode = failure;
    await overlay.refresh();
    assert.equal(overlay.get('acct_1'), null, `${failure} clears the overlay`);
  }
});

test('account-level Go block overrides a healthy Node runtime status', () => {
  const record = { accountRef: 'acct_1', runtimeStatus: 'healthy', lastUsedAt: NOW - 1000 };
  const next = applyGoRuntimeOverlay(record, {
    blocks: ['credentials_updated'], models: [], lastSuccessAt: NOW, lastFailureAt: 0, lastFailureKind: ''
  }, NOW);
  assert.equal(next.runtimeStatus, 'auth_invalid');
  assert.equal(next.runtimeReason, 'go_runtime_credentials_rejected');
  assert.equal(next.runtimeSource, 'go');
  assert.equal(next.lastUsedAt, NOW, 'Go success is newer than Node');
  assert.equal(record.runtimeStatus, 'healthy', 'input record is not mutated');
});

test('Node runtime block wins over the Go overlay', () => {
  const next = applyGoRuntimeOverlay(
    { accountRef: 'acct_1', runtimeStatus: 'rate_limited', runtimeReason: 'node', runtimeUntil: NOW + 5000 },
    { blocks: ['credentials_updated'], models: [], lastSuccessAt: 0, lastFailureAt: 0, lastFailureKind: '' },
    NOW
  );
  assert.equal(next.runtimeStatus, 'rate_limited');
  assert.equal(next.runtimeReason, 'node');
});

test('a model-level cooldown does not flip the account to unschedulable', () => {
  const next = applyGoRuntimeOverlay(
    { accountRef: 'acct_1', runtimeStatus: 'healthy', lastUsedAt: NOW },
    {
      blocks: [],
      models: [
        { model: 'gpt-5.5', blocks: [], cooldownKind: 'rate_limited', cooldownUntil: NOW + 60_000 },
        { model: 'gpt-5.4', blocks: [], cooldownKind: 'rate_limited', cooldownUntil: NOW - 1 }
      ],
      lastSuccessAt: NOW - 5000,
      lastFailureAt: NOW,
      lastFailureKind: 'rate_limited'
    },
    NOW
  );
  assert.equal(next.runtimeStatus, 'healthy');
  assert.deepEqual(next.runtimeModels.map((model) => model.model), ['gpt-5.5']);
  assert.equal(next.lastUsedAt, NOW, 'older Go success does not move lastUsedAt back');
});
