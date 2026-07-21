import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatRuntimeApiClient, ChatRuntimeApiError } from './api-client';
import type { ChatRuntimeTransport } from './api-types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createTransport(responses: Response[]) {
  const requests: Array<{ path: string; init?: RequestInit; port: 'json' | 'blob' }> = [];
  const transport: ChatRuntimeTransport = {
    fetch: async (path, init) => {
      requests.push({ path: String(path), init, port: 'json' });
      const response = responses.shift();
      if (!response) throw new Error('unexpected_request');
      return response;
    },
    fetchBlob: async (path, init) => {
      requests.push({ path: String(path), init, port: 'blob' });
      const response = responses.shift();
      if (!response) throw new Error('unexpected_request');
      return response.blob();
    },
    openEvents: () => { throw new Error('not_used'); },
  };
  return { requests, transport };
}

test('api client creates and lists canonical sessions', async () => {
  const { requests, transport } = createTransport([
    jsonResponse({ ok: true, session: session('session/one') }, 201),
    jsonResponse({ ok: true, sessions: [session('session/one')] }),
  ]);
  const client = new ChatRuntimeApiClient(transport);

  const created = await client.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
  });
  const listed = await client.listSessions({ provider: 'codex', projectPath: '/repo' });

  assert.equal(created.sessionId, 'session/one');
  assert.equal(listed[0].provider, 'codex');
  assert.equal(requests[0].path, '/v0/webui/chat/sessions');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[1].path, '/v0/webui/chat/sessions?provider=codex&projectPath=%2Frepo');
});

test('api client lists one canonical session for an exact native identity', async () => {
  const { requests, transport } = createTransport([
    jsonResponse({
      ok: true,
      sessions: [
        session('session-1', { nativeSessionId: 'thread/shared' }),
      ],
    }),
  ]);
  const client = new ChatRuntimeApiClient(transport);

  const listed = await client.listSessions({
    provider: 'codex',
    projectPath: '/repo',
    nativeSessionId: 'thread/shared',
  });

  assert.deepEqual(listed.map(({ executionAccountRef }) => executionAccountRef), ['account-1']);
  assert.equal(
    requests[0].path,
    '/v0/webui/chat/sessions?provider=codex&projectPath=%2Frepo&nativeSessionId=thread%2Fshared',
  );
});

test('api client resolves created and adopted native sessions through the canonical endpoint', async () => {
  const createdSession = session('session-created', {
    nativeSessionId: 'native-thread-1',
  });
  const adoptedSession = session('session-adopted', {
    nativeSessionId: 'native-thread-2',
  });
  const { requests, transport } = createTransport([
    jsonResponse({ ok: true, status: 'created', session: createdSession }, 201),
    jsonResponse({ ok: true, status: 'adopted', session: adoptedSession }),
  ]);
  const client = new ChatRuntimeApiClient(transport);

  const created = await client.resolveSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    nativeSessionId: 'native-thread-1', policy: { approvalMode: 'confirm' },
  });
  const adopted = await client.resolveSession({
    provider: 'codex', executionAccountRef: 'account-1', nativeSessionId: 'native-thread-2',
  });

  assert.equal(created.status, 'created');
  assert.equal(created.session.runtimeBinding.nativeSessionId, 'native-thread-1');
  assert.equal(adopted.status, 'adopted');
  assert.equal(adopted.session.sessionId, 'session-adopted');
  assert.equal(requests[0].path, '/v0/webui/chat/sessions/resolve');
  assert.equal(requests[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    nativeSessionId: 'native-thread-1', policy: { approvalMode: 'confirm' },
  });
});

test('api client rejects invalid session resolution status, identity, and native binding', async () => {
  const { transport } = createTransport([
    jsonResponse({ ok: true, status: 'reused', session: session('session-1') }),
    jsonResponse({ ok: true, status: 'created', session: {
      ...session('session-2'), provider: 'claude',
    } }),
    jsonResponse({ ok: true, status: 'adopted', session: session('session-3', {
      nativeSessionId: 'other-thread',
    }) }),
  ]);
  const client = new ChatRuntimeApiClient(transport);
  const input = {
    provider: 'codex', executionAccountRef: 'account-1', nativeSessionId: 'native-thread-1',
  } as const;

  await assert.rejects(
    client.resolveSession(input),
    /chat_runtime_session_resolution_status_invalid/,
  );
  await assert.rejects(
    client.resolveSession(input),
    /chat_runtime_session_provider_mismatch/,
  );
  await assert.rejects(
    client.resolveSession(input),
    /chat_runtime_native_session_mismatch/,
  );
});

test('api client validates snapshot and timeline session cursors', async () => {
  const { transport } = createTransport([
    jsonResponse({ ok: true, snapshot: snapshot('session-1', 4) }),
    jsonResponse({ ok: true, timeline: {
      sessionId: 'session-1', throughSeq: 4, items: [], hasMore: false, nextBefore: null,
    } }),
  ]);
  const client = new ChatRuntimeApiClient(transport);

  assert.equal((await client.getSnapshot('session-1')).throughSeq, 4);
  assert.equal((await client.readTimeline('session-1', { before: 'item/1', limit: 20 })).hasMore, false);
});

test('api client posts typed commands and reads command, composer, and artifact catalogs', async () => {
  const { requests, transport } = createTransport([
    jsonResponse({
      ok: true, sessionId: 'session/1', commandId: 'command-1', acceptedSeq: 5,
      duplicate: false, result: { queued: true },
    }, 202),
    jsonResponse({ ok: true, commands: [{ type: 'turn.submit', title: 'Send' }] }),
    jsonResponse({ ok: true, catalog: {
      models: [{
        id: 'gpt-5.6-sol', label: '5.6 Sol', supportedEfforts: ['medium', 'high'],
        defaultEffort: 'medium',
      }],
      defaultModel: 'gpt-5.6-sol',
    } }),
    new Response('artifact bytes', { status: 200, headers: { 'content-type': 'text/plain' } }),
  ]);
  const client = new ChatRuntimeApiClient(transport);

  const result = await client.dispatchCommand('session/1', {
    commandId: 'command-1', sessionId: 'session/1', type: 'turn.submit',
    payload: { content: 'hello' },
  });
  const catalog = await client.getCommandCatalog('session/1');
  const composerCatalog = await client.getComposerCatalog('session/1');
  const artifact = await client.readArtifact('artifact/1');

  assert.equal(result.acceptedSeq, 5);
  assert.equal(catalog[0].type, 'turn.submit');
  assert.equal(composerCatalog.models[0].defaultEffort, 'medium');
  assert.equal(await artifact.text(), 'artifact bytes');
  assert.equal(requests[0].path, '/v0/webui/chat/sessions/session%2F1/commands');
  assert.equal(requests[1].path, '/v0/webui/chat/sessions/session%2F1/commands/catalog');
  assert.equal(requests[2].path, '/v0/webui/chat/sessions/session%2F1/composer/catalog');
  assert.equal(requests[3].path, '/v0/webui/chat/artifacts/artifact%2F1');
  assert.equal(requests[3].port, 'blob');
});

test('api client uploads session-scoped image attachments', async () => {
  const { requests, transport } = createTransport([
    jsonResponse({
      ok: true,
      sessionId: 'session/1',
      attachments: [{
        attachmentId: 'attachment-1', sessionId: 'session/1',
        name: 'shot.png', mimeType: 'image/png', createdAt: 10,
      }],
    }, 201),
  ]);
  const client = new ChatRuntimeApiClient(transport);
  const input = [{
    name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==',
  }];

  const uploaded = await client.uploadAttachments('session/1', input);

  assert.equal(uploaded[0].attachmentId, 'attachment-1');
  assert.equal(requests[0].path, '/v0/webui/chat/sessions/session%2F1/attachments');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { attachments: input });
});

test('api client fails closed on HTTP and mismatched response identity', async () => {
  const http = new ChatRuntimeApiClient(createTransport([
    jsonResponse({ ok: false, error: 'chat_session_not_found' }, 404),
  ]).transport);
  await assert.rejects(http.getSnapshot('missing'), /chat_session_not_found/);

  const mismatch = new ChatRuntimeApiClient(createTransport([
    jsonResponse({ ok: true, snapshot: snapshot('other-session', 1) }),
  ]).transport);
  await assert.rejects(mismatch.getSnapshot('session-1'), /chat_runtime_session_mismatch/);
});

test('api client exposes non-2xx failures as typed runtime errors', async () => {
  const client = new ChatRuntimeApiClient(createTransport([
    jsonResponse({
      ok: false,
      error: 'chat_session_id_conflict',
      details: { sessionId: 'session-1' },
    }, 409),
  ]).transport);

  await assert.rejects(
    client.resolveSession({
      provider: 'codex', executionAccountRef: 'account-1', nativeSessionId: 'native-thread-1',
    }),
    (error) => error instanceof ChatRuntimeApiError
      && error.code === 'chat_session_id_conflict'
      && error.statusCode === 409
      && (error.details as { sessionId?: string }).sessionId === 'session-1',
  );
});

test('api client opens event streams with an encoded session and explicit cursor', () => {
  const paths: string[] = [];
  const stream = { onopen: null, onmessage: null, onerror: null, close() {} };
  const client = new ChatRuntimeApiClient({
    fetch: async () => { throw new Error('not_used'); },
    fetchBlob: async () => { throw new Error('not_used'); },
    openEvents(path) {
      paths.push(path);
      return stream;
    },
  });

  assert.equal(client.openEvents('session/1', 8), stream);
  assert.deepEqual(paths, ['/v0/webui/chat/sessions/session%2F1/events?after=8']);
  assert.throws(() => client.openEvents('session/1', -1), /chat_runtime_event_cursor_invalid/);
});

function session(sessionId: string, runtimeBinding: Record<string, unknown> = {}) {
  return {
    sessionId, provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
    state: 'idle', runtimeBinding, capabilitySnapshot: {}, policy: {},
    activeTurn: null, lastEventSeq: 0, createdAt: 1, updatedAt: 1,
  };
}

function snapshot(sessionId: string, throughSeq: number) {
  return {
    sessionId, state: 'idle', throughSeq, policy: {}, queue: [], interactions: [], timeline: [],
    timelineHasMore: false, timelineNextBefore: null,
  };
}
