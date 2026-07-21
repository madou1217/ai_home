import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@/types';
import {
  createRuntimeInstanceIdentity,
  expectNativeSessionAdoption,
  reconcileRuntimeInstanceIdentity,
} from './runtime-instance-identity';

function session(id: string, draft = false): Session {
  return { id, draft, title: id, provider: 'codex', projectPath: '/repo', updatedAt: 1 };
}

test('draft adoption preserves one runtime instance across the native id transition', () => {
  const draft = createRuntimeInstanceIdentity(session('draft-1', true));
  const expected = expectNativeSessionAdoption(draft, 'native-1');
  const adopted = reconcileRuntimeInstanceIdentity(expected, session('native-1'));
  assert.equal(adopted.key, draft.key);
  assert.equal(adopted.observedSessionId, 'native-1');
  assert.equal(adopted.pendingNativeSessionId, undefined);
});

test('selecting another session allocates a different runtime instance', () => {
  const current = createRuntimeInstanceIdentity(session('native-1'));
  const selected = reconcileRuntimeInstanceIdentity(current, session('native-2'));
  assert.notEqual(selected.key, current.key);
  assert.equal(selected.observedSessionId, 'native-2');
});
