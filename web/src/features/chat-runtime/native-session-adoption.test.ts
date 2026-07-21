import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRuntimeSession } from '@/chat-runtime';
import type { Session } from '@/types';
import {
  adoptDraftNativeSession,
  createFreshNativeSession,
  resolveNativeSessionAdoption,
} from './native-session-adoption';

const draft: Session = {
  id: 'draft-1',
  title: '新会话',
  updatedAt: 10,
  provider: 'codex',
  projectPath: '/repo',
  projectDirName: 'repo',
  draft: true,
};

test('draft adoption preserves user-visible session metadata', () => {
  assert.deepEqual(adoptDraftNativeSession({
    session: draft,
  }, 'thread-1', 20), {
    ...draft,
    id: 'thread-1',
    draft: false,
    updatedAt: 20,
  });
});

test('fresh adoption creates a native session without draft-only identity', () => {
  assert.deepEqual(createFreshNativeSession({
    session: draft,
    projectPath: '/fallback',
  }, 'thread-2', 30), {
    id: 'thread-2',
    title: '新会话',
    updatedAt: 30,
    provider: 'codex',
    projectPath: '/repo',
    projectDirName: 'repo',
    draft: false,
  });
});

test('resolved runtime adoption reconciles only the native identity', () => {
  const resolved = runtimeSession({
    runtimeBinding: { nativeSessionId: 'thread-3' },
    updatedAt: 40,
  });

  assert.deepEqual(resolveNativeSessionAdoption(draft, resolved), {
    nativeSessionId: 'thread-3',
    session: {
      ...draft,
      id: 'thread-3',
      draft: false,
      updatedAt: 40,
    },
  });
});

test('resolved runtime adoption fails closed and avoids duplicate writes', () => {
  const current = { ...draft, id: 'thread-4', draft: false };
  const resolved = runtimeSession({
    runtimeBinding: { nativeSessionId: 'thread-4' },
  });
  assert.deepEqual(resolveNativeSessionAdoption(current, resolved), {
    nativeSessionId: 'thread-4',
    session: null,
  });
  assert.equal(resolveNativeSessionAdoption(current, runtimeSession({
    ...resolved,
    provider: 'claude',
    runtimeBinding: { nativeSessionId: 'foreign-thread' },
  })), null);
});

function runtimeSession(
  overrides: Partial<ChatRuntimeSession> = {},
): ChatRuntimeSession {
  return {
    sessionId: 'canonical-1',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    state: 'idle',
    lastEventSeq: 0,
    createdAt: 1,
    updatedAt: 20,
    policy: {},
    runtimeBinding: {},
    capabilitySnapshot: {},
    ...overrides,
  };
}
