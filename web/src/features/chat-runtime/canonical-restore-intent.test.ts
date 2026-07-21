import assert from 'node:assert/strict';
import test from 'node:test';
import type { AggregatedProject } from '@/types';
import { CanonicalRestoreIntent } from './canonical-restore-intent';

const initial = {
  projectPath: '/repo-a',
  sessionId: 'native-a',
  provider: 'codex',
};
const project: AggregatedProject = {
  id: 'repo-a',
  name: 'repo-a',
  path: '/repo-a',
  providers: ['codex'],
  sessions: [],
};

test('restore intent is one-shot after its project directory has been observed', () => {
  const intent = new CanonicalRestoreIntent(initial);
  assert.deepEqual(intent.selection(), initial);
  intent.observe({ ready: false, projects: [], selectedSession: null });
  assert.equal(intent.isPending(), true);
  intent.observe({ ready: true, projects: [project], selectedSession: null });
  assert.equal(intent.isPending(), false);
  assert.deepEqual(intent.selection(), {});
});

test('explicit selection mutation cancels restore before a late directory response', () => {
  const intent = new CanonicalRestoreIntent(initial);
  intent.cancel();
  intent.observe({ ready: true, projects: [project], selectedSession: null });
  assert.equal(intent.isPending(), false);
  assert.deepEqual(intent.selection(), {});
});
