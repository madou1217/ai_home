import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, Session, SessionMessageBundle } from '@/types';
import {
  isSameLegacySession,
  legacySessionCacheKey,
  legacySessionEffectKey,
  LegacySessionHistoryState,
} from './legacy-session-history-state';
import { canReconnectSelectedSession } from './use-selected-session-watch';
import { resolveResumeLifecycleAction } from './use-session-resume-lifecycle';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'thread-1',
    title: 'Thread 1',
    updatedAt: 1,
    provider: 'claude',
    projectPath: '/repo',
    projectDirName: '-repo',
    ...overrides,
  };
}

function window(messages: ChatMessage[]): SessionMessageBundle {
  return {
    messages,
    start: 10,
    total: 10 + messages.length,
    hasMore: true,
    cursor: 8,
  };
}

test('legacy history state isolates messages, windows, cursors, and page-load locks by exact session', () => {
  const state = new LegacySessionHistoryState();
  const first = session();
  const second = session({ projectDirName: '-other-repo' });
  const messages: ChatMessage[] = [{ role: 'assistant', content: 'done' }];
  const historyWindow = window(messages);

  state.writeMessages(first, messages);
  state.writeWindow(first, historyWindow);
  state.writeCursor(first, 8);

  assert.equal(state.readMessages(first), messages);
  assert.equal(state.readWindow(first), historyWindow);
  assert.equal(state.readCursor(first), 8);
  assert.equal(state.readMessages(second), undefined);
  assert.equal(state.readCursor(second), 0);
  assert.equal(state.beginOlderPageLoad(first), true);
  assert.equal(state.beginOlderPageLoad(first), false);
  state.finishOlderPageLoad(first);
  assert.equal(state.beginOlderPageLoad(first), true);

  state.resetSnapshot(first);
  assert.equal(state.readMessages(first), undefined);
  assert.equal(state.readWindow(first), undefined);
  assert.equal(state.readCursor(first), 8);
});

test('legacy session identity includes provider, native id, project directory, and draft lifecycle', () => {
  const saved = session();
  const draft = session({ draft: true });
  const otherProvider = session({ provider: 'codex' });

  assert.equal(legacySessionCacheKey(saved), 'claude:thread-1:-repo');
  assert.equal(legacySessionEffectKey(saved), 'claude:thread-1:-repo:saved');
  assert.equal(legacySessionEffectKey(draft), 'claude:thread-1:-repo:draft');
  assert.equal(isSameLegacySession(saved, draft), true);
  assert.equal(isSameLegacySession(saved, otherProvider), false);
});

test('selected session watch reconnects for the same online saved session while hidden', () => {
  const watchedSession = session();
  const base = {
    enabled: true,
    online: true,
    selectedSession: watchedSession,
    watchedSession,
  };

  assert.equal(canReconnectSelectedSession(base), true);
  assert.equal(canReconnectSelectedSession({ ...base, enabled: false }), false);
  assert.equal(canReconnectSelectedSession({ ...base, online: false }), false);
  assert.equal(canReconnectSelectedSession({ ...base, selectedSession: session({ id: 'thread-2' }) }), false);
  assert.equal(canReconnectSelectedSession({ ...base, selectedSession: session({ draft: true }) }), false);
});

test('resume lifecycle keeps pause and debounce timing policy explicit', () => {
  assert.deepEqual(resolveResumeLifecycleAction('visibility-hidden'), { kind: 'pause' });
  assert.deepEqual(resolveResumeLifecycleAction('visibility-visible'), { kind: 'resume', delayMs: 350 });
  assert.deepEqual(resolveResumeLifecycleAction('pageshow'), { kind: 'resume', delayMs: 350 });
  assert.deepEqual(resolveResumeLifecycleAction('online'), { kind: 'resume', delayMs: 600 });
});
