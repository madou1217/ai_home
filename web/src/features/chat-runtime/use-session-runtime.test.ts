import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChatRuntimeApi,
  ChatRuntimeCommand,
  ChatRuntimeEventStream,
  ChatRuntimeSession,
  SessionSnapshot,
} from '@/chat-runtime';
import type { Session } from '@/types';
import { resolveBoundNativeSessionId } from './native-session-adoption';
import type { SessionRuntimeTarget } from './session-surface-policy';
import { openSessionRuntime } from './use-session-runtime';

const target: SessionRuntimeTarget = {
  provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
  nativeSessionId: 'native-1', policy: { approvalMode: 'confirm' },
};

test('runtime open resolves native identity without duplicating server prewarm', async () => {
  const fixture = fakeApi();
  installAnimationFrame();
  let resolvedSession: ChatRuntimeSession | undefined;
  const controller = await openSessionRuntime(
    target,
    fixture.api,
    (session) => { resolvedSession = session; },
  );

  assert.equal(fixture.resolveCount, 1);
  assert.deepEqual(fixture.commands, []);
  assert.equal(controller.sessionId, 'session-1');
  assert.equal(resolvedSession?.executionAccountRef, 'account-1');
  controller.dispose();
});

test('native resolution failure is surfaced without trying session creation', async () => {
  const fixture = fakeApi();
  fixture.api.resolveSession = async () => { throw new Error('native unavailable'); };
  await assert.rejects(() => openSessionRuntime(target, fixture.api), /native unavailable/);
  assert.equal(fixture.createCount, 0);
});

test('native identity guard failure disposes the opened runtime controller', async () => {
  const fixture = fakeApi();
  installAnimationFrame();
  const selectedSession: Session = {
    id: 'native-1', title: 'Existing', updatedAt: 1, provider: 'codex',
    projectPath: '/repo', draft: false,
  };
  fixture.api.resolveSession = async () => ({
    status: 'adopted',
    session: {
      ...runtimeSession(),
      runtimeBinding: { nativeSessionId: 'native-other' },
    },
  });

  await assert.rejects(
    () => openSessionRuntime(target, fixture.api, (resolved) => {
      resolveBoundNativeSessionId(selectedSession, resolved.runtimeBinding);
    }),
    /chat_runtime_native_session_mismatch/,
  );
  assert.equal(fixture.closedStreams, 1);
});

function fakeApi(): {
  api: ChatRuntimeApi;
  commands: ChatRuntimeCommand[];
  resolveCount: number;
  createCount: number;
  closedStreams: number;
} {
  const fixture = {
    commands: [] as ChatRuntimeCommand[], resolveCount: 0, createCount: 0, closedStreams: 0,
  };
  const session = runtimeSession();
  const api: ChatRuntimeApi = {
    createSession: async () => { fixture.createCount += 1; return session; },
    resolveSession: async () => {
      fixture.resolveCount += 1;
      return { status: 'adopted', session };
    },
    listSessions: async () => [session],
    getSnapshot: async () => snapshot(),
    readTimeline: async () => ({
      sessionId: 'session-1', items: [], hasMore: false, nextBefore: null, throughSeq: 0,
    }),
    dispatchCommand: async (_sessionId, command) => {
      fixture.commands.push(command);
      return { sessionId: 'session-1', commandId: command.commandId, acceptedSeq: 1, duplicate: false };
    },
    getCommandCatalog: async () => [],
    getComposerCatalog: async () => ({ models: [], defaultModel: '' }),
    uploadAttachments: async () => [],
    readArtifact: async () => new Blob(),
    openEvents: () => eventStream(() => { fixture.closedStreams += 1; }),
  };
  return Object.assign(fixture, { api });
}

function runtimeSession(): ChatRuntimeSession {
  return {
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '/repo', state: 'idle', lastEventSeq: 0,
    createdAt: 1, updatedAt: 1, policy: {}, runtimeBinding: {}, capabilitySnapshot: {},
  };
}

function snapshot(): SessionSnapshot {
  return {
    sessionId: 'session-1', state: 'idle', throughSeq: 0, policy: {},
    queue: [], interactions: [], timeline: [], timelineHasMore: false,
    timelineNextBefore: null,
  };
}

function eventStream(onClose: () => void = () => {}): ChatRuntimeEventStream {
  return { onopen: null, onmessage: null, onerror: null, close: onClose };
}

function installAnimationFrame(): void {
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
}
