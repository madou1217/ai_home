import assert from 'node:assert/strict';
import test from 'node:test';

import { queueRowPolicy } from './queue-row-policy';
import type { SessionQueueEntry } from '@/chat-runtime';

test('queued rows expose only valid mutation and dispatch actions', () => {
  const queue = [entry('running', 0), entry('queued', 1), entry('queued', 2)];

  assert.deepEqual(queueRowPolicy(queue, 1, 'running'), {
    mutable: true,
    canDispatch: false,
    moveDown: {},
  });
  assert.deepEqual(queueRowPolicy(queue, 1, 'idle'), {
    mutable: true,
    canDispatch: true,
    moveDown: {},
  });
  assert.deepEqual(queueRowPolicy(queue, 2, 'idle'), {
    mutable: true,
    canDispatch: true,
    moveUp: { beforeQueueId: 'queue-1' },
  });
});

test('leased and running rows never expose queue mutation actions', () => {
  const queue = [entry('leased', 0), entry('running', 1), entry('queued', 2)];

  assert.deepEqual(queueRowPolicy(queue, 0, 'idle'), {
    mutable: false,
    canDispatch: false,
  });
  assert.deepEqual(queueRowPolicy(queue, 1, 'idle'), {
    mutable: false,
    canDispatch: false,
  });
});

function entry(status: SessionQueueEntry['status'], position: number): SessionQueueEntry {
  return {
    queueId: `queue-${position}`,
    sessionId: 'session-1',
    commandId: `command-${position}`,
    position,
    policy: 'after_turn',
    payload: { content: `message-${position}` },
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}
