import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionRuntimeController } from './session-runtime-controller';
import type { SessionConnectionState } from './projection-types';
import type {
  ChatRuntimeApi,
  ChatRuntimeEventStream,
  ReconnectScheduler,
  TimelinePage,
  TimelineQuery,
} from './api-types';
import type { FrameScheduler } from './frame-scheduler';
import type { ChatRuntimeCommand, ChatRuntimeEvent, SessionSnapshot } from './types';

class FakeStream implements ChatRuntimeEventStream {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  close(): void { this.closed = true; }
  open(): void { this.onopen?.(new Event('open')); }
  message(value: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
  error(): void { this.onerror?.(new Event('error')); }
}

function createFixture(
  snapshots: Array<SessionSnapshot | Error>,
  timelinePages: TimelinePage[] = [],
) {
  const streams: Array<{ sessionId: string; after: number; stream: FakeStream }> = [];
  const commands: ChatRuntimeCommand[] = [];
  let snapshotReads = 0;
  const reconnects: Array<() => void> = [];
  const timelineReads: Array<{ sessionId: string; query?: TimelineQuery }> = [];
  const api = {
    getSnapshot: async () => {
      const result = snapshots[Math.min(snapshotReads++, snapshots.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
    openEvents(sessionId: string, after: number) {
      const stream = new FakeStream();
      streams.push({ sessionId, after, stream });
      return stream;
    },
    async readTimeline(sessionId: string, query?: TimelineQuery) {
      timelineReads.push({ sessionId, query });
      const page = timelinePages.shift();
      if (!page) throw new Error('unexpected_timeline_read');
      return page;
    },
    async dispatchCommand(sessionId: string, command: ChatRuntimeCommand) {
      commands.push(command);
      return {
        sessionId, commandId: command.commandId, acceptedSeq: 1, duplicate: false,
      };
    },
  } as unknown as ChatRuntimeApi;
  const reconnectScheduler: ReconnectScheduler = (callback) => {
    reconnects.push(callback);
    return () => {
      const index = reconnects.indexOf(callback);
      if (index >= 0) reconnects.splice(index, 1);
    };
  };
  const frameScheduler: FrameScheduler = {
    request(callback) {
      callback(0);
      return { cancel() {} };
    },
    cancel(handle) { handle.cancel(); },
  };
  const controller = new SessionRuntimeController('session-1', api, {
    frameScheduler,
    reconnectScheduler,
  });
  return {
    commands, controller, reconnects, streams, timelineReads,
    snapshotReads: () => snapshotReads,
  };
}

test('controller bootstraps snapshot before opening an event cursor', async () => {
  const fixture = createFixture([snapshot(4)]);

  await fixture.controller.start();

  assert.equal(fixture.controller.store.getSnapshot().throughSeq, 4);
  assert.equal(connectionState(fixture.controller), 'connecting');
  assert.deepEqual(fixture.streams[0], {
    sessionId: 'session-1', after: 4, stream: fixture.streams[0].stream,
  });
  fixture.streams[0].stream.open();
  assert.equal(connectionState(fixture.controller), 'connected');
  fixture.controller.dispose();
});

test('controller reconnects with the latest applied sequence after stream error', async () => {
  const fixture = createFixture([snapshot(4)]);
  await fixture.controller.start();
  fixture.streams[0].stream.open();
  fixture.streams[0].stream.message(event(5));

  fixture.streams[0].stream.error();
  assert.equal(fixture.streams[0].stream.closed, true);
  assert.equal(connectionState(fixture.controller), 'reconnecting');
  assert.equal(fixture.reconnects.length, 1);
  fixture.reconnects.shift()?.();

  assert.equal(fixture.streams[1].after, 5);
  assert.equal(connectionState(fixture.controller), 'reconnecting');
  fixture.streams[1].stream.open();
  assert.equal(connectionState(fixture.controller), 'connected');
  fixture.controller.dispose();
});

test('controller rejects stale commands until the replacement stream opens', async () => {
  const fixture = createFixture([snapshot(4)]);
  await fixture.controller.start();

  await assert.rejects(
    fixture.controller.dispatch({
      commandId: 'command-1', type: 'turn.submit', payload: { content: 'hello' },
    }),
    /chat_runtime_connection_not_ready/,
  );
  assert.equal(fixture.commands.length, 0);

  fixture.streams[0].stream.open();
  await fixture.controller.dispatch({
    commandId: 'command-2', type: 'turn.submit', payload: { content: 'hello' },
  });
  assert.equal(fixture.commands.length, 1);

  fixture.streams[0].stream.error();
  await assert.rejects(
    fixture.controller.dispatch({
      commandId: 'command-3', type: 'turn.submit', payload: { content: 'stale' },
    }),
    /chat_runtime_connection_not_ready/,
  );
  assert.equal(fixture.commands.length, 1);
  fixture.controller.dispose();
});

test('controller clears an old stream failure after the replacement stream applies an event', async () => {
  const fixture = createFixture([snapshot(4)]);
  await fixture.controller.start();
  fixture.streams[0].stream.message(streamError('first_failure'));
  assert.equal(fixture.controller.store.getSnapshot().streamFailure?.error, 'first_failure');

  fixture.streams[0].stream.error();
  const staleStream = fixture.streams[0].stream;
  fixture.reconnects.shift()?.();
  assert.equal(fixture.controller.store.getSnapshot().streamFailure?.error, 'first_failure');

  staleStream.message(event(5));
  assert.equal(fixture.controller.store.getSnapshot().streamFailure?.error, 'first_failure');
  fixture.streams[1].stream.message(event(5));
  assert.equal(fixture.controller.store.getSnapshot().streamFailure, undefined);
  fixture.controller.dispose();
});

test('failed snapshot resync retains the stream failure while scheduling retry', async () => {
  const fixture = createFixture([snapshot(4), new Error('snapshot unavailable')]);
  await fixture.controller.start();
  fixture.streams[0].stream.open();
  fixture.streams[0].stream.message(streamError('still_failed'));
  fixture.streams[0].stream.message({ ...event(5), schema: 'provider.private.v1' });
  await settle();

  assert.equal(connectionState(fixture.controller), 'resyncing');
  assert.equal(fixture.controller.store.getSnapshot().streamFailure?.error, 'still_failed');
  assert.equal(fixture.controller.store.getSnapshot().throughSeq, 4);
  assert.equal(fixture.reconnects.length, 1);
  fixture.controller.dispose();
});

test('snapshot resync clears an old stream failure', async () => {
  const fixture = createFixture([snapshot(4), snapshot(6)]);
  await fixture.controller.start();
  fixture.streams[0].stream.message(streamError('stale_failure'));
  fixture.streams[0].stream.message({ ...event(5), schema: 'provider.private.v1' });
  await settle();

  assert.equal(fixture.controller.store.getSnapshot().streamFailure, undefined);
  assert.equal(fixture.streams[1].after, 6);
  fixture.controller.dispose();
});

test('controller replaces a gapped projection from a fresh snapshot', async () => {
  const fixture = createFixture([snapshot(4), snapshot(9)]);
  await fixture.controller.start();
  fixture.streams[0].stream.open();

  fixture.streams[0].stream.message(event(7));
  assert.equal(connectionState(fixture.controller), 'resyncing');
  await settle();

  assert.equal(fixture.streams[0].stream.closed, true);
  assert.equal(fixture.snapshotReads(), 2);
  assert.equal(fixture.streams[1].after, 9);
  assert.equal(connectionState(fixture.controller), 'resyncing');
  fixture.streams[1].stream.open();
  assert.equal(connectionState(fixture.controller), 'connected');
  fixture.controller.dispose();
});

test('controller fails closed and resyncs malformed or foreign events', async () => {
  const fixture = createFixture([snapshot(4), snapshot(6)]);
  await fixture.controller.start();
  fixture.streams[0].stream.message({ ...event(5), schema: 'provider.private.v1' });
  await settle();

  assert.equal(fixture.snapshotReads(), 2);
  assert.equal(fixture.streams[1].after, 6);
  fixture.controller.dispose();
});

test('controller dispose closes stream and cancels pending reconnect', async () => {
  const fixture = createFixture([snapshot(1)]);
  await fixture.controller.start();
  fixture.streams[0].stream.error();

  fixture.controller.dispose();

  assert.equal(fixture.streams[0].stream.closed, true);
  assert.equal(fixture.reconnects.length, 0);
});

test('controller binds its session identity to dispatched commands', async () => {
  const fixture = createFixture([snapshot(1)]);
  await fixture.controller.start();
  fixture.streams[0].stream.open();

  await fixture.controller.dispatch({
    commandId: 'command-1', type: 'turn.submit', payload: { content: 'hello' },
  });

  assert.equal(fixture.commands[0].sessionId, 'session-1');
  fixture.controller.dispose();
});

test('controller loads earlier timeline from the projected first item and prepends it once', async () => {
  const initial = {
    ...snapshot(4), timeline: [item('item-2')], timelineHasMore: true,
    timelineNextBefore: 'item-2',
  };
  const fixture = createFixture([initial], [{
    sessionId: 'session-1', items: [item('item-1')], hasMore: false,
    nextBefore: null, throughSeq: 4,
  }]);
  await fixture.controller.start();

  const page = await fixture.controller.loadEarlier();

  assert.deepEqual(fixture.timelineReads, [{
    sessionId: 'session-1', query: { before: 'item-2', limit: 20 },
  }]);
  assert.equal(page.hasMore, false);
  assert.deepEqual(
    fixture.controller.store.getSnapshot().items.map(({ id }) => id),
    ['item-1', 'item-2'],
  );
  assert.equal(fixture.controller.store.getSnapshot().timelineHasMore, false);
  fixture.controller.dispose();
});

function snapshot(throughSeq: number): SessionSnapshot {
  return {
    sessionId: 'session-1', state: 'idle', throughSeq,
    policy: {}, queue: [], interactions: [], timeline: [],
    timelineHasMore: false, timelineNextBefore: null,
  };
}

function item(id: string) {
  return {
    id, kind: 'message' as const, status: 'completed' as const, createdAt: 1,
    content: id, detail: { role: 'assistant' as const },
  };
}

function event(seq: number): ChatRuntimeEvent {
  return {
    schema: 'aih.chat.event.v1', eventId: `event-${seq}`, sessionId: 'session-1', seq,
    type: 'turn.started', at: seq, source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: { state: 'running', activeTurn: { turnId: 'turn-1', state: 'running' } },
  };
}

function streamError(error: string): ChatRuntimeEvent<'stream.error'> {
  return {
    schema: 'aih.chat.event.v1', eventId: `stream-error-${error}`,
    sessionId: 'session-1', seq: 0, type: 'stream.error', at: 1,
    source: { provider: 'unknown', runtimeId: 'aih-chat-runtime' },
    payload: { error, message: error, retryable: true },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function connectionState(controller: SessionRuntimeController): SessionConnectionState {
  return controller.store.getSnapshot().connectionState;
}
