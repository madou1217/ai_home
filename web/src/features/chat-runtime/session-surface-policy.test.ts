import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account, ChatAccount, Session } from '@/types';
import {
  resolveSessionRuntimeTarget,
  runtimeAccountsForSession,
  usesCanonicalSessionRuntime,
} from './session-surface-policy';

const savedSession: Session = {
  id: 'native-thread-1', title: 'Runtime', updatedAt: 1,
  provider: 'codex', projectPath: '/repo',
};

const account: Account = {
  provider: 'codex', accountRef: 'account-1', status: 'up', displayName: 'Codex',
  configured: true, apiKeyMode: false, remainingPct: null, updatedAt: 1,
  planType: 'plus', email: 'user@example.com',
};

test('Codex sessions select the canonical surface at the composition boundary', () => {
  assert.equal(usesCanonicalSessionRuntime(savedSession, account), true);
  assert.equal(usesCanonicalSessionRuntime(savedSession, { ...account, apiKeyMode: true }), false);
  assert.equal(usesCanonicalSessionRuntime({ ...savedSession, provider: 'claude' }), false);
});

test('saved sessions resolve the current native identity without a legacy fallback', () => {
  assert.deepEqual(resolveSessionRuntimeTarget({
    session: savedSession,
    account,
    approvalMode: 'plan',
  }), {
    status: 'ready',
    target: {
      provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
      nativeSessionId: 'native-thread-1', policy: { approvalMode: 'plan' },
    },
  });
});

test('native runtime rejects API-key and gateway accounts', () => {
  const gateway = {
    ...account, gateway: true as const, accountRef: undefined,
  } as unknown as ChatAccount;
  assert.equal(resolveSessionRuntimeTarget({
    session: savedSession,
    account: gateway,
    approvalMode: 'bypass',
  }).status, 'blocked');
  const apiKey = { ...account, accountRef: 'key-1', apiKeyMode: true };
  assert.equal(resolveSessionRuntimeTarget({
    session: savedSession,
    account: apiKey,
    approvalMode: 'bypass',
  }).status, 'blocked');
  assert.deepEqual(runtimeAccountsForSession(savedSession, [account, apiKey]), [account]);
});

test('draft sessions create a canonical target without inventing native identity', () => {
  const result = resolveSessionRuntimeTarget({
    session: { ...savedSession, id: 'draft-1', draft: true },
    account,
    approvalMode: 'bypass',
  });
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.target.nativeSessionId, undefined);

  assert.deepEqual(resolveSessionRuntimeTarget({
    session: savedSession,
    account: { ...account, provider: 'claude' },
    approvalMode: 'bypass',
  }), { status: 'blocked', reason: 'provider_mismatch' });
});

test('saved sessions use the currently selected credential without credential binding', () => {
  assert.equal(resolveSessionRuntimeTarget({
    session: savedSession,
    account,
    approvalMode: 'confirm',
  }).status, 'ready');
});
