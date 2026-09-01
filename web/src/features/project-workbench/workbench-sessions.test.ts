import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkbenchSessions } from './workbench-sessions.ts';

const projects = [
  {
    id: 'p1',
    name: 'alpha',
    path: '/repo/alpha',
    providers: ['claude'],
    sessions: [
      { id: 's1', title: '会话一', updatedAt: 200, provider: 'claude', projectPath: '/repo/alpha' },
      { id: 's2', title: '会话二', updatedAt: 100, provider: 'claude', projectPath: '/repo/alpha' },
    ],
  },
  {
    id: 'p2',
    name: 'beta',
    path: '/repo/beta',
    providers: ['codex'],
    sessions: [
      { id: 's3', title: '会话三', updatedAt: 300, provider: 'codex', projectPath: '/repo/beta' },
    ],
  },
] as any;

test('resolveWorkbenchSessions 返回当前项目的会话组', () => {
  const sessions = resolveWorkbenchSessions(projects, '/repo/alpha');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]!.id, 's1');
});

test('resolveWorkbenchSessions 未选项目/项目不存在时返回空', () => {
  assert.deepEqual(resolveWorkbenchSessions(projects, undefined), []);
  assert.deepEqual(resolveWorkbenchSessions(projects, ''), []);
  assert.deepEqual(resolveWorkbenchSessions(projects, '/repo/ghost'), []);
  assert.deepEqual(resolveWorkbenchSessions([], '/repo/alpha'), []);
});
