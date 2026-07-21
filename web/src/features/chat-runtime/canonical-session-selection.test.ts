import assert from 'node:assert/strict';
import test from 'node:test';
import type { AggregatedProject, Session } from '@/types';
import {
  resolveCanonicalSessionSelection,
  shouldConsumeCanonicalRestoreIntent,
} from './canonical-session-selection';

const projectPath = '/workspace/repo';
const canonicalSession: Session = {
  id: 'native-1',
  title: '保留历史标题',
  updatedAt: 20,
  provider: 'codex',
  projectPath,
  status: 'idle',
};
const directoryProjects: AggregatedProject[] = [{
  id: 'repo',
  name: 'repo',
  path: projectPath,
  providers: ['codex'],
  sessions: [canonicalSession],
}];

test('canonical selection restores the persisted native session after a hard reload', () => {
  assert.deepEqual(resolveCanonicalSessionSelection({
    ready: true,
    projects: directoryProjects,
    selectedSession: null,
    persistedSelection: {
      projectPath,
      sessionId: 'native-1',
      provider: 'codex',
    },
  }), {
    projectId: 'repo',
    projectPath,
    session: canonicalSession,
  });
});

test('canonical selection refreshes runtime state without requiring an owner', () => {
  const historySession: Session = {
    ...canonicalSession,
    updatedAt: 10,
    status: undefined,
  };

  assert.equal(resolveCanonicalSessionSelection({
    ready: true,
    projects: directoryProjects,
    selectedSession: historySession,
    persistedSelection: {},
  })?.session, canonicalSession);
  assert.equal(resolveCanonicalSessionSelection({
    ready: true,
    projects: directoryProjects,
    selectedSession: canonicalSession,
    persistedSelection: {},
  }), null);
});

test('canonical selection does not override an explicit different session', () => {
  assert.equal(resolveCanonicalSessionSelection({
    ready: true,
    projects: directoryProjects,
    selectedSession: { ...canonicalSession, id: 'native-other' },
    persistedSelection: {
      projectPath,
      sessionId: 'native-1',
      provider: 'codex',
    },
  }), null);
  assert.equal(resolveCanonicalSessionSelection({
    ready: false,
    projects: directoryProjects,
    selectedSession: null,
    persistedSelection: {
      projectPath,
      sessionId: 'native-1',
      provider: 'codex',
    },
  }), null);
});

test('canonical hard-reload restore intent is consumed before a later explicit clear', () => {
  const persistedSelection = {
    projectPath,
    sessionId: 'native-1',
    provider: 'codex',
  };
  assert.equal(shouldConsumeCanonicalRestoreIntent({
    ready: true,
    projects: directoryProjects,
    selectedSession: null,
    persistedSelection,
  }), true);
  assert.equal(shouldConsumeCanonicalRestoreIntent({
    ready: true,
    projects: [],
    selectedSession: null,
    persistedSelection,
  }), false);
});
