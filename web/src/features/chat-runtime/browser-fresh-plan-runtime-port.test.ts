import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionProjectionStore } from '@/chat-runtime';
import type {
  ChatRuntimeApi,
  ChatRuntimeCommand,
  ChatRuntimeEventStream,
  ChatRuntimeSession,
  FrameScheduler,
  SessionSnapshot,
} from '@/chat-runtime';
import {
  BrowserFreshPlanRuntimePort,
  waitForNativeSessionId,
} from './browser-fresh-plan-runtime-port';
import { FreshPlanRuntimeOpenError } from './fresh-plan-implementation-workflow';
import type { SessionRuntimeTarget } from './session-surface-policy';

const immediateFrames: FrameScheduler = {
  request(callback) { callback(0); return { cancel() {} }; },
  cancel(handle) { handle.cancel(); },
};

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
}

test('fresh runtime waits for asynchronous SSE open before returning and accepting submit', async () => {
  installImmediateFrames();
  const fixture = createApiFixture();
  const port = new BrowserFreshPlanRuntimePort(fixture.api, {
    nativeBindTimeoutMs: 1000,
    connectionTimeoutMs: 1000,
  });
  let resolvedRuntime: Awaited<ReturnType<typeof port.open>> | undefined;
  const opening = port.open(runtimeTarget);
  void opening.then((runtime) => { resolvedRuntime = runtime; });

  await settle(8);
  assert.equal(fixture.streams.length, 1);
  assert.equal(resolvedRuntime, undefined);
  assert.equal(fixture.commands.length, 0);

  fixture.streams[0].open();
  const runtime = await opening;
  await runtime.submit('command-1', 'Implement the plan.');
  runtime.close();

  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.commands[0].commandId, 'command-1');
  assert.equal(fixture.streams[0].closed, true);
});

test('fresh runtime connection timeout is distinct from native binding timeout and disposes', async () => {
  installImmediateFrames();
  const fixture = createApiFixture();
  const port = new BrowserFreshPlanRuntimePort(fixture.api, {
    nativeBindTimeoutMs: 1000,
    connectionTimeoutMs: 5,
  });

  await assert.rejects(
    port.open(runtimeTarget),
    (error) => error instanceof FreshPlanRuntimeOpenError
      && error.originalError instanceof Error
      && error.originalError.message === 'chat_fresh_runtime_connection_timeout',
  );

  assert.equal(fixture.streams[0].closed, true);
});

test('fresh runtime stream failure rejects connection readiness and disposes', async () => {
  installImmediateFrames();
  const fixture = createApiFixture();
  const port = new BrowserFreshPlanRuntimePort(fixture.api, {
    nativeBindTimeoutMs: 1000,
    connectionTimeoutMs: 1000,
  });
  const opening = port.open(runtimeTarget);
  await settle();

  fixture.streams[0].message(streamFailureEvent());

  await assert.rejects(
    opening,
    (error) => error instanceof FreshPlanRuntimeOpenError
      && error.originalError instanceof Error
      && error.originalError.message === 'chat_fresh_runtime_connection_failed',
  );
  assert.equal(fixture.streams[0].closed, true);
});

test('fresh runtime binding waiter resolves from the canonical projection', async () => {
  const store = createStore();
  const binding = waitForNativeSessionId(store, 1000);

  store.reset(snapshot({
    state: 'running',
    runtimeBinding: { nativeSessionId: 'native-fresh-1' },
  }));

  assert.equal(await binding, 'native-fresh-1');
});

test('fresh runtime binding waiter treats idle-unbound timeout as pending, not missing', async () => {
  const store = createStore();
  const binding = waitForNativeSessionId(store, 10);
  let settled = false;
  void binding.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  store.reset(snapshot({ state: 'running' }));
  store.reset(snapshot({ state: 'idle' }));

  await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(binding, /chat_fresh_native_session_pending/);
});

function createStore(): SessionProjectionStore {
  const store = new SessionProjectionStore('session-1', immediateFrames);
  store.reset(snapshot());
  return store;
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-1', state: 'idle', throughSeq: 0, policy: {},
    queue: [], interactions: [], timeline: [], timelineHasMore: false,
    timelineNextBefore: null, ...overrides,
  };
}

const runtimeTarget: SessionRuntimeTarget = {
  provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
  policy: { approvalMode: 'confirm' },
};

function createApiFixture(): {
  readonly api: ChatRuntimeApi;
  readonly commands: ChatRuntimeCommand[];
  readonly streams: FakeStream[];
} {
  const commands: ChatRuntimeCommand[] = [];
  const streams: FakeStream[] = [];
  const session: ChatRuntimeSession = {
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '/repo', state: 'idle', lastEventSeq: 0,
    createdAt: 1, updatedAt: 1, policy: {}, runtimeBinding: {}, capabilitySnapshot: {},
  };
  const api: ChatRuntimeApi = {
    createSession: async () => session,
    resolveSession: async () => ({ status: 'adopted', session }),
    listSessions: async () => [session],
    getSnapshot: async () => snapshot(),
    readTimeline: async () => ({
      sessionId: 'session-1', items: [], hasMore: false, nextBefore: null, throughSeq: 0,
    }),
    dispatchCommand: async (_sessionId, command) => {
      commands.push(command);
      return {
        sessionId: 'session-1', commandId: command.commandId,
        acceptedSeq: 1, duplicate: false,
      };
    },
    getCommandCatalog: async () => [],
    getComposerCatalog: async () => ({ models: [], defaultModel: '' }),
    uploadAttachments: async () => [],
    readArtifact: async () => new Blob(),
    openEvents: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  };
  return { api, commands, streams };
}

function streamFailureEvent() {
  return {
    schema: 'aih.chat.event.v1', eventId: 'stream-error-1',
    sessionId: 'session-1', seq: 0, type: 'stream.error', at: 1,
    source: { provider: 'unknown', runtimeId: 'aih-chat-runtime' },
    payload: { error: 'stream_failed', message: 'Stream failed', retryable: true },
  };
}

function installImmediateFrames(): void {
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
}

async function settle(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}
