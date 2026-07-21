import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRuntimeApi, ChatRuntimeSession } from '@/chat-runtime';
import type { AggregatedProject, Session } from '@/types';
import {
  buildCanonicalSessionDirectoryQueries,
  loadCanonicalSessionDirectory,
  mergeCanonicalSessionDirectory,
  overlayCanonicalSessionDirectoryFocus,
  resolveCanonicalSessionDirectoryFocus,
} from './canonical-session-directory';

const projectPath = '/workspace/repo';

test('canonical directory projects native identity without credential ownership', async () => {
  const queries = buildCanonicalSessionDirectoryQueries([
    { ...project('repo-a', projectPath, []), providers: [] },
    project('repo-b', projectPath, []),
  ], ['codex', 'codex']);
  assert.deepEqual(queries, [{ provider: 'codex', projectPath }]);

  const calls: Array<{ provider?: string; projectPath?: string }> = [];
  const api: Pick<ChatRuntimeApi, 'listSessions'> = {
    listSessions: async (query = {}) => {
      calls.push(query);
      return [
        runtimeSession('runtime-1', 'native-1', 'credential-1'),
        runtimeSession('runtime-2', undefined, 'credential-2'),
      ];
    },
  };

  const directory = await loadCanonicalSessionDirectory(queries, api);
  assert.deepEqual(calls, [{ provider: 'codex', projectPath }]);
  assert.deepEqual(directory.sessions, [{
    id: 'native-1',
    title: '新会话',
    updatedAt: 20,
    provider: 'codex',
    projectPath,
    status: 'idle',
  }]);
});

test('canonical directory adds an exact query for the focused native identity', () => {
  assert.deepEqual(buildCanonicalSessionDirectoryQueries(
    [project('repo', projectPath, [])],
    ['codex'],
    { provider: 'codex', projectPath, nativeSessionId: 'native-old' },
  ), [
    { provider: 'codex', projectPath },
    { provider: 'codex', projectPath, nativeSessionId: 'native-old' },
  ]);
  assert.deepEqual(resolveCanonicalSessionDirectoryFocus(null, {
    provider: 'codex', projectPath, nativeSessionId: 'native-old',
  }), {
    provider: 'codex', projectPath, nativeSessionId: 'native-old',
  });
});

test('focused exact directory replaces stale cached runtime metadata', () => {
  const base = directoryResult([
    canonicalSession('native-focus', 100, 'running'),
    canonicalSession('native-other', 50, 'idle'),
  ]);
  const exact = canonicalSession('native-focus', 110, 'idle');

  const overlaid = overlayCanonicalSessionDirectoryFocus(
    base,
    directoryResult([exact]),
    { provider: 'codex', projectPath, nativeSessionId: 'native-focus' },
  );

  assert.deepEqual(overlaid.sessions, [exact, canonicalSession('native-other', 50, 'idle')]);
});

test('canonical directory merges runtime state without adding an account to history', () => {
  const history: Session = {
    id: 'native-1',
    title: '保留 provider 历史标题',
    updatedAt: 10,
    provider: 'codex',
    projectPath,
    preview: '保留历史预览',
  };
  const canonical = canonicalSession('native-1', 20, 'running');

  const [merged] = mergeCanonicalSessionDirectory([
    project('repo', projectPath, [history]),
  ], [canonical]);

  assert.deepEqual(merged.sessions, [{
    ...history,
    updatedAt: 20,
    status: 'running',
  }]);
  assert.equal('accountRef' in merged.sessions[0], false);
});

test('canonical directory deduplicates legacy duplicate rows by native identity', async () => {
  const older = runtimeSession('runtime-old', 'native-duplicate', 'credential-old');
  const newer = {
    ...runtimeSession('runtime-new', 'native-duplicate', 'credential-new'),
    updatedAt: 30,
    state: 'running' as const,
  };
  const directory = await loadCanonicalSessionDirectory([
    { provider: 'codex', projectPath },
  ], { listSessions: async () => [older, newer] });

  assert.deepEqual(directory.sessions, [canonicalSession('native-duplicate', 30, 'running')]);
});

test('canonical directory rejects non-string native identities at the projection boundary', async () => {
  const malformed = runtimeSession('runtime-invalid', 'native-valid', 'credential-1');
  (malformed.runtimeBinding as { nativeSessionId: unknown }).nativeSessionId = { invalid: true };
  const directory = await loadCanonicalSessionDirectory([
    { provider: 'codex', projectPath },
  ], { listSessions: async () => [malformed] });
  assert.deepEqual(directory, { sessions: [] });
});

function project(id: string, path: string, sessions: Session[]): AggregatedProject {
  return { id, name: id, path, providers: ['codex'], sessions };
}

function directoryResult(sessions: readonly Session[]) {
  return { sessions };
}

function canonicalSession(
  id: string,
  updatedAt: number,
  status: Session['status'],
): Session {
  return {
    id,
    title: '新会话',
    updatedAt,
    provider: 'codex',
    projectPath,
    status,
  };
}

function runtimeSession(
  sessionId: string,
  nativeSessionId: string | undefined,
  executionAccountRef: string,
): ChatRuntimeSession {
  return {
    sessionId,
    provider: 'codex',
    executionAccountRef,
    projectPath,
    state: 'idle',
    lastEventSeq: 0,
    createdAt: 10,
    updatedAt: 20,
    policy: {},
    runtimeBinding: nativeSessionId ? { nativeSessionId } : {},
    capabilitySnapshot: {},
  };
}
