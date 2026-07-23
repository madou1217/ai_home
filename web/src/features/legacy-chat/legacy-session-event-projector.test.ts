import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, SessionEventItem } from '@/types';
import { projectLegacySessionEvents } from './legacy-session-event-projector';

const session: Session = {
  id: 'session-1', provider: 'claude', title: 'Session', updatedAt: 1, projectPath: '/repo',
};

test('legacy event projector deduplicates users and exposes ordered effects', () => {
  const events = [
    { type: 'user_message', content: 'hello', timestamp: '1' },
    { type: 'assistant_reasoning', content: 'thinking', timestamp: '2' },
    { type: 'assistant_tool_call', content: 'tool', timestamp: '3' },
  ] as SessionEventItem[];
  const projection = projectLegacySessionEvents({
    messages: [{ role: 'user', content: 'hello', timestamp: '1' }],
    events,
    session,
    current: true,
    running: true,
  });

  assert.equal(projection.messages.filter((item) => item.role === 'user').length, 1);
  assert.deepEqual(projection.effects, ['mark_thinking', 'tool_boundary', 'clear_pending']);
});

test('legacy event projector merges a near-duplicate user event instead of duplicating it', () => {
  const projection = projectLegacySessionEvents({
    messages: [{ role: 'user', content: '  hello  ', images: [], timestamp: '2026-01-01T00:00:00.000Z' }],
    events: [
      {
        type: 'user_message',
        content: 'hello',
        images: ['a.png'],
        timestamp: '2026-01-01T00:00:00.010Z',
        source: 'codex-mobile',
      } as SessionEventItem,
    ],
    session,
    current: false,
    running: false,
  });

  const userMessages = projection.messages.filter((item) => item.role === 'user');
  assert.equal(userMessages.length, 1);
  assert.deepEqual(userMessages[0].images, ['a.png']);
  assert.equal(userMessages[0].source, 'codex-mobile');
  assert.equal(userMessages[0].timestamp, '2026-01-01T00:00:00.010Z');
});

test('legacy event projector keeps background clear-pending effects local to the visible session', () => {
  const projection = projectLegacySessionEvents({
    messages: [],
    events: [{ type: 'assistant_text', content: 'done', timestamp: '1' } as SessionEventItem],
    session,
    current: false,
    running: false,
  });
  assert.deepEqual(projection.effects, []);
});
