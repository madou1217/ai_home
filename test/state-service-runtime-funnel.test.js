'use strict';

// CLI 进程的运行态写入必须走服务端（stateIndexClient），不再直写 app-state.db。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountStateService } = require('../lib/account/state-service');

const REF = 'acct_0123456789abcdef0123';

function createService(t, overrides = {}) {
  const calls = [];
  const client = {
    upsertRuntimeState: (...args) => { calls.push(['put', ...args]); },
    clearRuntimeState: (...args) => { calls.push(['clear', ...args]); }
  };
  const index = {
    getAccountState: () => ({ accountRef: REF, status: 'up', runtimeState: null }),
    upsertRuntimeState: () => { throw new Error('local runtime write must not happen'); },
    upsertAccountState: () => true,
    ...overrides
  };
  return {
    calls,
    service: createAccountStateService({ accountStateIndex: index, stateIndexClient: client })
  };
}

test('recordRuntimeFailure forwards to the server client', (t) => {
  const { calls, service } = createService(t);
  const recorded = service.recordRuntimeFailure(REF, 'codex', {
    lastFailureKind: 'auth_invalid',
    lastFailureAt: 1000,
    authInvalidUntil: 2000
  }, { status: 'up' });
  assert.equal(recorded, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'put');
  assert.equal(calls[0][1], REF);
  assert.equal(calls[0][3].lastFailureKind, 'auth_invalid');
});

test('clearing with no local runtime state asks the server to clear', (t) => {
  const { calls, service } = createService(t);
  const cleared = service.clearRuntimeBlock(REF, 'codex', { evidence: 'login_success' });
  assert.equal(cleared, true);
  assert.deepEqual(calls[0].slice(0, 2), ['clear', REF]);
});
