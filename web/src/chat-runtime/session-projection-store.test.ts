import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionProjectionStore } from './session-projection-store';
import type { FrameScheduler } from './frame-scheduler';
import type { ChatRuntimeEvent, PendingInteraction, SessionQueueEntry, SessionSnapshot } from './types';

const immediateFrames: FrameScheduler = {
  request(callback) { callback(0); return { cancel() {} }; },
  cancel(handle) { handle.cancel(); },
};

test('projection keeps only active queue entries and pending interactions', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot({ queue: [queue()], interactions: [interaction()] }));

  store.apply(event(1, 'queue.item.updated', {
    entry: { ...queue(), status: 'completed' },
  }));
  store.apply(event(2, 'interaction.resolved', {
    interaction: { ...interaction(), state: 'answered' },
  }));

  assert.deepEqual(store.getSnapshot().queue, []);
  assert.deepEqual(store.getSnapshot().interactions, []);
});

test('projection restores a released interaction after reconnecting while it was resolving', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot({ interactions: [] }));

  store.apply(event(1, 'interaction.updated', {
    interaction: { ...interaction(), state: 'pending', updatedAt: 2 },
  }));

  assert.deepEqual(store.getSnapshot().interactions.map(({ interactionId }) => interactionId), [
    'interaction-1',
  ]);
});

test('projection keeps a resolving interaction for disabled rendering', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot({ interactions: [interaction()] }));

  store.apply(event(1, 'interaction.updated', {
    interaction: { ...interaction(), state: 'resolving', updatedAt: 2 },
  }));

  assert.equal(store.getSnapshot().interactions[0].state, 'resolving');
});

test('projection prepends history in order and deduplicates live items by id', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot({
    timeline: [item('item-2'), item('item-3')],
    timelineHasMore: true,
    timelineNextBefore: 'item-2',
  }));

  store.prependTimeline({
    sessionId: 'session-1', items: [item('item-1'), item('item-2')],
    hasMore: false, nextBefore: null, throughSeq: 0,
  });

  const projection = store.getSnapshot();
  assert.deepEqual(projection.items.map(({ id }) => id), ['item-1', 'item-2', 'item-3']);
  assert.equal(projection.timelineHasMore, false);
  assert.equal(projection.timelineNextBefore, null);
});

test('projection follows detached, reattached, and lost recovery semantics', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot({
    state: 'running',
    activeTurn: {
      turnId: 'turn-1', runId: 'run-1', clientUserMessageId: 'message-1',
      nativeTurnId: 'native-turn-1', state: 'running',
    },
  }));

  store.apply(event(1, 'run.detached', { reason: 'server_restart' }, {
    turnId: 'turn-1', runId: 'run-1',
  }));
  assert.equal(store.getSnapshot().state, 'recovering');
  assert.deepEqual(store.getSnapshot().activeTurn, {
    turnId: 'turn-1', runId: 'run-1', clientUserMessageId: 'message-1',
    nativeTurnId: 'native-turn-1', state: 'recovering',
  });

  store.apply(event(2, 'run.reattached', {
    state: 'waiting_input', nativeTurnId: 'native-turn-2',
  }, {
    turnId: 'turn-1', runId: 'run-1',
  }));
  assert.equal(store.getSnapshot().state, 'waiting_input');
  assert.deepEqual(store.getSnapshot().activeTurn, {
    turnId: 'turn-1', runId: 'run-1', clientUserMessageId: 'message-1',
    nativeTurnId: 'native-turn-2', state: 'waiting_input',
  });

  store.apply(event(3, 'run.lost', { error: { code: 'native_run_lost' } }, {
    turnId: 'turn-1', runId: 'run-1',
  }));
  assert.equal(store.getSnapshot().state, 'idle');
  assert.equal(store.getSnapshot().activeTurn, undefined);
});

test('projection clears only the active stream failure after an accepted event', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot());
  store.apply(event(0, 'stream.error', {
    error: 'stream_failed', message: 'Stream failed', retryable: true,
  }));
  assert.equal(store.getSnapshot().streamFailure?.error, 'stream_failed');
  assert.equal(lastItem(store), undefined);

  store.apply(event(1, 'session.policy.changed', {
    policy: { approvalMode: 'confirm' },
  }));

  assert.equal(store.getSnapshot().streamFailure, undefined);
  assert.equal(lastItem(store), undefined);
});

test('projection retains the latest stream failure across duplicates and gaps until reset', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot());
  const first = event(0, 'stream.error', {
    error: 'stream_a', message: 'Stream A', retryable: true,
  });
  store.apply(first);
  store.apply(first);
  assert.equal(store.getSnapshot().throughSeq, 0);
  assert.equal(store.getSnapshot().streamFailure?.error, 'stream_a');
  assert.equal(store.getSnapshot().items.filter(({ kind }) => kind === 'error').length, 0);

  store.apply(event(0, 'stream.error', {
    error: 'stream_b', message: 'Stream B', retryable: true,
  }, { eventId: 'stream-error-b' }));
  assert.equal(store.getSnapshot().throughSeq, 0);
  assert.equal(store.getSnapshot().streamFailure?.error, 'stream_b');
  assert.equal(store.getSnapshot().items.filter(({ kind }) => kind === 'error').length, 0);

  assert.equal(store.apply(event(3, 'session.policy.changed', { policy: {} })).status, 'gap');
  assert.equal(store.getSnapshot().streamFailure?.error, 'stream_b');

  store.reset(snapshot({ throughSeq: 4 }));
  assert.equal(store.getSnapshot().streamFailure, undefined);
  assert.equal(store.getSnapshot().items.length, 0);
});

test('projection keeps terminal stream errors in the timeline', () => {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot());

  store.apply(event(0, 'stream.error', {
    error: 'request_rejected', message: 'Request rejected', retryable: false,
  }));

  assert.equal(store.getSnapshot().streamFailure?.retryable, false);
  assert.equal(lastItem(store)?.kind, 'error');
});

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-1', state: 'idle', throughSeq: 0, policy: {},
    queue: [], interactions: [], timeline: [], timelineHasMore: false,
    timelineNextBefore: null, ...overrides,
  };
}

function lastItem(store: SessionProjectionStore) {
  const items = store.getSnapshot().items;
  return items[items.length - 1];
}

function item(id: string) {
  return {
    id, kind: 'message' as const, status: 'completed' as const, createdAt: 1,
    content: id, detail: { role: 'assistant' as const },
  };
}

function queue(): SessionQueueEntry {
  return {
    queueId: 'queue-1', sessionId: 'session-1', commandId: 'command-1', position: 1,
    policy: 'after_turn', payload: {}, status: 'queued', createdAt: 1, updatedAt: 1,
  };
}

function interaction(): PendingInteraction {
  return {
    interactionId: 'interaction-1', sessionId: 'session-1', itemId: 'item-1',
    kind: 'approval', revision: 1,
    payload: {
      presentation: { title: '审批' },
      choices: [{ id: 'allow', label: '允许', intent: 'accept' }],
    },
    state: 'pending', createdAt: 1, updatedAt: 1,
  };
}

function event(
  seq: number,
  type: ChatRuntimeEvent['type'],
  payload: object,
  identity: Partial<Pick<ChatRuntimeEvent, 'eventId' | 'turnId' | 'runId'>> = {},
): ChatRuntimeEvent {
  return {
    schema: 'aih.chat.event.v1', eventId: `event-${seq}`, sessionId: 'session-1', seq,
    type, at: seq, source: { provider: 'codex', runtimeId: 'runtime-1' }, payload,
    ...identity,
  } as ChatRuntimeEvent;
}
