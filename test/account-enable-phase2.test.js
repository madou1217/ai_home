'use strict';

// Phase 2：账号 enabled（用户意图）与运行态阻塞分离。
//
// 两条断言：
//   1. auth_invalid 的自动 retain 只写运行态，不再把 account_state.status 改成 down；
//   2. 历史遗留的「系统 retain 导致的 down」在索引启动时归一为 up（运行态阻塞保留），
//      用户手动停用的 down 保持不动。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCodexAuthInvalidReconciler } = require('../lib/cli/services/usage/codex-auth-invalid-reconciler');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

const REF = 'acct_00000000000000000001';

test('auth_invalid retain 只写运行态，不改用户启停 status', () => {
  const calls = [];
  const service = {
    getAccountState: () => ({ status: 'up', configured: true, runtimeState: {} }),
    recordRuntimeFailure: (...args) => {
      calls.push({ kind: 'runtime', args });
      return true;
    },
    setOperationalStatus: (...args) => {
      calls.push({ kind: 'status', args });
      return true;
    }
  };
  const reconciler = createCodexAuthInvalidReconciler({
    fs,
    aiHomeDir: '/tmp/aih-phase2-test',
    accountStateService: service,
    schedule: () => {}
  });
  const result = reconciler.__private.retainAccount(REF, 'auth_invalid');
  assert.equal(result.retained, true);
  assert.deepEqual(calls.map((call) => call.kind), ['runtime'], '不得写 status');
});

test('启动归一：系统 retain 的 down 变 up，用户停用的 down 保持', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-phase2-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const systemRetainedRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'phase2:system-retained'
  });
  const userDisabledRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '2',
    identitySeed: 'phase2:user-disabled'
  });
  const first = createAccountStateIndex({ aiHomeDir, fs });
  first.upsertAccountState(systemRetainedRef, 'codex', { status: 'down', configured: true });
  first.upsertRuntimeState(systemRetainedRef, 'codex', {
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'account_recovery_required:auth_invalid',
    authInvalidUntil: Date.now() + 3600_000
  }, { status: 'down', configured: true });
  first.upsertAccountState(userDisabledRef, 'codex', { status: 'down', configured: true });
  first.close();

  const second = createAccountStateIndex({ aiHomeDir, fs });
  t.after(() => second.close());
  assert.equal(second.getAccountState(systemRetainedRef).status, 'up', '系统 retain 的账号状态应归一为用户启用');
  assert.equal(second.getAccountState(userDisabledRef).status, 'down', '用户手动停用的账号必须保持停用');
  // 运行态阻塞仍然保留：可路由判定靠它，而不是靠 status。
  const runtime = second.getAccountState(systemRetainedRef).runtimeState || {};
  assert.equal(runtime.lastFailureKind, 'auth_invalid');
});
