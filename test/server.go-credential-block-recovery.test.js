'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoCredentialBlockRecovery } = require('../lib/server/go-credential-block-recovery');

function setup({ rows, links = { acct_node_codex: 'acct_go_codex', acct_node_key: 'acct_go_key' }, providers } = {}) {
  const calls = [];
  let clock = 1_000_000;
  let runtime = rows;
  const recovery = createGoCredentialBlockRecovery({
    listAccountRuntime: async () => runtime,
    readGoRefsByNodeRef: () => links,
    resolveProvider: (nodeRef) => (providers || { acct_node_codex: 'codex', acct_node_key: 'claude' })[nodeRef] || '',
    reconciler: {
      enqueueDirectHttpStatus401(provider, accountRef, reason) {
        calls.push({ provider, accountRef, reason });
        return true;
      }
    },
    retryAfterMs: 60_000,
    now: () => clock
  });
  return {
    recovery,
    calls,
    advance(ms) { clock += ms; },
    setRows(next) { runtime = next; }
  };
}

const blocked = (goRef, lastFailureMs) => ({ account_ref: goRef, blocks: ['credentials_updated'], last_failure_ms: lastFailureMs });

test('Go 凭据阻塞的 codex 账号以 401 身份交给修复器刷新,只入队一次', async () => {
  const f = setup({ rows: [blocked('acct_go_codex', 500)] });
  assert.equal(await f.recovery.poll(), 1);
  assert.deepEqual(f.calls, [{
    provider: 'codex',
    accountRef: 'acct_node_codex',
    reason: 'direct_http_status_401:go_runtime_credentials_rejected'
  }]);
  // 同一次阻塞反复上报(每轮轮询)不重复入队
  f.advance(10 * 60_000);
  assert.equal(await f.recovery.poll(), 0);
  assert.equal(f.calls.length, 1);
});

test('刷新后 Go 立刻再次拒收时,冷却窗口内不再打 token 端点,窗口后才重试', async () => {
  const f = setup({ rows: [blocked('acct_go_codex', 500)] });
  await f.recovery.poll();
  f.setRows([blocked('acct_go_codex', 900)]);
  f.advance(30_000);
  assert.equal(await f.recovery.poll(), 0);
  f.advance(60_000);
  assert.equal(await f.recovery.poll(), 1);
  assert.equal(f.calls.length, 2);
});

test('非 codex 账号与非凭据阻塞不入队', async () => {
  const f = setup({
    rows: [
      blocked('acct_go_key', 500),
      { account_ref: 'acct_go_codex', blocks: ['usage_snapshot'], last_failure_ms: 500 }
    ]
  });
  assert.equal(await f.recovery.poll(), 0);
  assert.deepEqual(f.calls, []);
});

test('Go 不可用时不入队也不抛错', async () => {
  const f = setup({ rows: null });
  assert.equal(await f.recovery.poll(), 0);
});
