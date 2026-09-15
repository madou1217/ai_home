import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@/types';
import { preserveCanonicalSessionIdentity } from './project-selection-policy';

test('native project snapshots cannot erase the selected canonical branch binding', () => {
  const current: Session = { id: 'native-child', runtimeSessionId: 'canonical-child', accountRef: 'a',
    provider: 'codex', projectPath: '/repo', mode: 'work', title: '任务 · 分支', updatedAt: 10 };
  const incoming: Session = { id: 'native-child', provider: 'codex', projectPath: '/repo',
    title: 'native title', status: 'running', updatedAt: 20 };
  assert.deepEqual(preserveCanonicalSessionIdentity(current, incoming), {
    ...current, status: 'running', updatedAt: 20,
  });
  assert.equal(preserveCanonicalSessionIdentity(current, { ...incoming, provider: 'claude' }).accountRef, undefined);
  assert.equal(preserveCanonicalSessionIdentity(current, { ...incoming, projectPath: '/other' }).runtimeSessionId, undefined);
});
