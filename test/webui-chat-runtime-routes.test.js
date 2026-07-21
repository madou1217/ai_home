'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  handleWebUiChatRuntimeRequest
} = require('../lib/server/webui-chat-runtime-routes');

function createResponse() {
  const response = new EventEmitter();
  return Object.assign(response, {
    body: '',
    headers: {},
    statusCode: 0,
    writableEnded: false,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    },
    end(chunk = '') {
      this.body += String(chunk);
      this.writableEnded = true;
    }
  });
}

function createContext(method, pathname, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  const req = new EventEmitter();
  req.url = `${pathname}${options.query || ''}`;
  req.headers = { host: '127.0.0.1:9527', ...(options.headers || {}) };
  const res = createResponse();
  const writes = [];
  return {
    method,
    pathname,
    req,
    res,
    deps: { chatRuntimeService: options.service },
    readRequestBody: async () => body,
    writeJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
      res.statusCode = statusCode;
      res.end(JSON.stringify(payload));
    },
    writes
  };
}

test('chat runtime route ignores unrelated paths', async () => {
  const ctx = createContext('GET', '/v0/webui/projects', { service: {} });
  assert.equal(await handleWebUiChatRuntimeRequest(ctx), false);
});

test('chat runtime route creates and lists stable sessions', async () => {
  const calls = [];
  const service = {
    async createSession(payload) {
      calls.push(['create', payload]);
      return { sessionId: 'session-1', ...payload };
    },
    async listSessions(query) {
      calls.push(['list', query]);
      return [{ sessionId: 'session-1' }];
    }
  };
  const createCtx = createContext('POST', '/v0/webui/chat/sessions', {
    service,
    body: { provider: 'codex', projectPath: '/repo' }
  });
  assert.equal(await handleWebUiChatRuntimeRequest(createCtx), true);
  assert.equal(createCtx.writes[0].statusCode, 201);
  assert.equal(createCtx.writes[0].payload.session.sessionId, 'session-1');

  const listCtx = createContext('GET', '/v0/webui/chat/sessions', {
    service,
    query: '?provider=codex&projectPath=%2Frepo'
  });
  assert.equal(await handleWebUiChatRuntimeRequest(listCtx), true);
  assert.equal(listCtx.writes[0].statusCode, 200);
  assert.deepEqual(listCtx.writes[0].payload.sessions, [{ sessionId: 'session-1' }]);
  assert.deepEqual(calls[1], ['list', { provider: 'codex', projectPath: '/repo' }]);
});

test('chat runtime route uploads images through the session attachment boundary', async () => {
  const calls = [];
  const service = {
    async uploadAttachments(sessionId, payload) {
      calls.push({ sessionId, payload });
      return [{
        attachmentId: 'attachment-1', sessionId,
        name: 'shot.png', mimeType: 'image/png', createdAt: 1
      }];
    }
  };
  const body = {
    attachments: [{
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ=='
    }]
  };
  const ctx = createContext(
    'POST',
    '/v0/webui/chat/sessions/session%2Fone/attachments',
    { service, body }
  );

  assert.equal(await handleWebUiChatRuntimeRequest(ctx), true);
  assert.equal(ctx.writes[0].statusCode, 201);
  assert.equal(ctx.writes[0].payload.attachments[0].attachmentId, 'attachment-1');
  assert.deepEqual(calls, [{ sessionId: 'session/one', payload: body }]);
});

test('chat runtime session list forwards the exact native identity filter', async () => {
  let received;
  const service = {
    async listSessions(query) {
      received = query;
      return [
        { sessionId: 'session-1', executionAccountRef: 'account-1' }
      ];
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/sessions', {
    service,
    query: '?provider=codex&projectPath=%2Frepo&nativeSessionId=thread%2Fshared'
  });

  assert.equal(await handleWebUiChatRuntimeRequest(ctx), true);

  assert.deepEqual(received, {
    provider: 'codex',
    projectPath: '/repo',
    nativeSessionId: 'thread/shared'
  });
  assert.deepEqual(
    ctx.writes[0].payload.sessions.map(({ executionAccountRef }) => executionAccountRef),
    ['account-1']
  );
});

test('session create forwards only the public create DTO fields', async () => {
  let received;
  const service = {
    async createSession(payload) {
      received = payload;
      return { sessionId: 'session-safe', ...payload };
    }
  };
  const ctx = createContext('POST', '/v0/webui/chat/sessions', {
    service,
    body: {
      provider: 'codex',
      executionAccountRef: 'account-1',
      projectPath: '/repo',
      policy: { approvalMode: 'confirm' },
      sessionId: 'client-session',
      state: 'running',
      nativeSessionId: 'client-native',
      runtimeBinding: { runtimeId: 'client-runtime' },
      capabilitySnapshot: { revision: 'client-capabilities' },
      activeTurn: { turnId: 'client-turn' }
    }
  });

  await handleWebUiChatRuntimeRequest(ctx);

  assert.deepEqual(received, {
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    policy: { approvalMode: 'confirm' }
  });
  assert.equal(ctx.writes[0].statusCode, 201);
});

test('session create schedules production prewarm after returning the canonical session', async () => {
  const calls = [];
  let response;
  const service = {
    async createSession(payload) {
      return {
        sessionId: 'session-prewarm',
        runtimeBinding: { runtimeGeneration: 4 },
        ...payload
      };
    },
    async dispatchCommand(sessionId, command) {
      calls.push({ responseEnded: response.writableEnded, sessionId, command });
      return { sessionId, commandId: command.commandId };
    }
  };
  const ctx = createContext('POST', '/v0/webui/chat/sessions', {
    service,
    body: { provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo' }
  });
  response = ctx.res;

  await handleWebUiChatRuntimeRequest(ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.writes[0].statusCode, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].responseEnded, true);
  assert.equal(calls[0].sessionId, 'session-prewarm');
  assert.match(calls[0].command.commandId, /^runtime-prewarm:/);
  assert.deepEqual({
    type: calls[0].command.type,
    payload: calls[0].command.payload
  }, {
    type: 'runtime.prewarm',
    payload: {}
  });
});

test('chat runtime route resolves or adopts a native session idempotently', async () => {
  const calls = [];
  let status = 'created';
  const service = {
    async resolveSession(payload) {
      calls.push(payload);
      return {
        status,
        session: { sessionId: 'session-stable', runtimeBinding: {
          nativeSessionId: payload.nativeSessionId
        } }
      };
    }
  };
  const body = {
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    nativeSessionId: 'thread-1',
    policy: { approvalMode: 'ask' }
  };
  const created = createContext('POST', '/v0/webui/chat/sessions/resolve', { service, body });
  assert.equal(await handleWebUiChatRuntimeRequest(created), true);
  assert.equal(created.writes[0].statusCode, 201);
  assert.equal(created.writes[0].payload.status, 'created');

  status = 'adopted';
  const adopted = createContext('POST', '/v0/webui/chat/sessions/resolve', { service, body });
  assert.equal(await handleWebUiChatRuntimeRequest(adopted), true);
  assert.equal(adopted.writes[0].statusCode, 200);
  assert.equal(adopted.writes[0].payload.status, 'adopted');
  assert.equal(adopted.writes[0].payload.session.sessionId, 'session-stable');
  assert.deepEqual(calls, [body, body]);
});

test('session create and adoption schedule production runtime prewarm commands', async () => {
  const commands = [];
  const service = {
    async createSession(payload) {
      return { sessionId: 'session-created', ...payload };
    },
    async resolveSession(payload) {
      return {
        status: 'adopted',
        session: { sessionId: 'session-adopted', ...payload }
      };
    },
    async dispatchCommand(sessionId, command) {
      commands.push({ sessionId, command });
      return { sessionId, commandId: command.commandId };
    }
  };
  const create = createContext('POST', '/v0/webui/chat/sessions', {
    service,
    body: { provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo' }
  });
  const adopt = createContext('POST', '/v0/webui/chat/sessions/resolve', {
    service,
    body: {
      provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo',
      nativeSessionId: 'thread-1'
    }
  });

  await handleWebUiChatRuntimeRequest(create);
  await handleWebUiChatRuntimeRequest(adopt);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(create.writes[0].statusCode, 201);
  assert.equal(adopt.writes[0].statusCode, 200);
  assert.deepEqual(commands.map(({ sessionId, command }) => ({
    sessionId,
    type: command.type,
    payload: command.payload,
    validCommandId: /^runtime-prewarm:[0-9a-f-]+$/.test(command.commandId)
  })), [
    {
      sessionId: 'session-created', type: 'runtime.prewarm', payload: {},
      validCommandId: true
    },
    {
      sessionId: 'session-adopted', type: 'runtime.prewarm', payload: {},
      validCommandId: true
    }
  ]);
});

test('chat runtime route exposes snapshot, timeline, command catalog, and composer catalog', async () => {
  const service = {
    async getSnapshot(sessionId) {
      return { sessionId, throughSeq: 4 };
    },
    async readTimeline(sessionId, page) {
      return { sessionId, ...page, items: [] };
    },
    async getCommandCatalog(sessionId) {
      return [{ id: 'turn.submit', sessionId }];
    },
    async readComposerCatalog(sessionId) {
      return {
        sessionId,
        models: [{ id: 'gpt-5.6-sol', supportedEfforts: ['medium', 'high'] }],
        defaultModel: 'gpt-5.6-sol'
      };
    }
  };
  const snapshotCtx = createContext('GET', '/v0/webui/chat/sessions/session-1/snapshot', { service });
  await handleWebUiChatRuntimeRequest(snapshotCtx);
  assert.equal(snapshotCtx.writes[0].payload.snapshot.throughSeq, 4);

  const timelineCtx = createContext('GET', '/v0/webui/chat/sessions/session-1/timeline', {
    service,
    query: '?before=abc&limit=20'
  });
  await handleWebUiChatRuntimeRequest(timelineCtx);
  assert.equal(timelineCtx.writes[0].payload.timeline.before, 'abc');
  assert.equal(timelineCtx.writes[0].payload.timeline.limit, 20);

  const catalogCtx = createContext('GET', '/v0/webui/chat/sessions/session-1/commands/catalog', { service });
  await handleWebUiChatRuntimeRequest(catalogCtx);
  assert.equal(catalogCtx.writes[0].payload.commands[0].id, 'turn.submit');

  const composerCtx = createContext('GET', '/v0/webui/chat/sessions/session-1/composer/catalog', { service });
  await handleWebUiChatRuntimeRequest(composerCtx);
  assert.equal(composerCtx.writes[0].payload.catalog.defaultModel, 'gpt-5.6-sol');
});

test('chat runtime route accepts idempotent typed commands', async () => {
  const service = {
    async dispatchCommand(sessionId, command) {
      return { sessionId, commandId: command.commandId, acceptedSeq: 8 };
    }
  };
  const ctx = createContext('POST', '/v0/webui/chat/sessions/session-1/commands', {
    service,
    body: { commandId: 'command-1', type: 'turn.submit', payload: { prompt: 'hi' } }
  });
  await handleWebUiChatRuntimeRequest(ctx);
  assert.equal(ctx.writes[0].statusCode, 202);
  assert.deepEqual(ctx.writes[0].payload, {
    ok: true,
    sessionId: 'session-1',
    commandId: 'command-1',
    acceptedSeq: 8
  });
});

test('chat runtime route preserves typed error status and code', async () => {
  const service = {
    async getSnapshot() {
      const error = new Error('interaction is stale');
      error.code = 'stale_interaction';
      error.statusCode = 409;
      throw error;
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/sessions/session-1/snapshot', { service });
  await handleWebUiChatRuntimeRequest(ctx);
  assert.equal(ctx.writes[0].statusCode, 409);
  assert.equal(ctx.writes[0].payload.error, 'stale_interaction');
});

test('chat runtime route returns only sanitized canonical diagnostics', async () => {
  const service = {
    async getSnapshot() {
      const error = new Error('upstream Authorization: Bearer route-message-secret');
      error.code = 'codex_app_server_disconnected';
      error.statusCode = 503;
      error.details = {
        sessionId: 'session-1',
        authorization: 'Bearer route-detail-secret',
        nested: { cookie: 'session=route-cookie-secret' }
      };
      throw error;
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/sessions/session-1/snapshot', { service });

  await handleWebUiChatRuntimeRequest(ctx);

  assert.deepEqual(ctx.writes[0], {
    statusCode: 503,
    payload: {
      ok: false,
      error: 'codex_app_server_disconnected',
      message: 'upstream Authorization: Bearer [redacted]',
      details: {
        sessionId: 'session-1',
        authorization: '[redacted]',
        nested: { cookie: '[redacted]' }
      }
    }
  });
  assert.doesNotMatch(
    JSON.stringify(ctx.writes[0]),
    /route-message-secret|route-detail-secret|route-cookie-secret/
  );
});

test('chat runtime route streams replay events from Last-Event-ID', async () => {
  let requestedAfter = 0;
  const service = {
    async readEvents(_sessionId, options) {
      requestedAfter = options.after;
      return {
        events: [{ seq: 12, type: 'turn.started', payload: {} }],
        throughSeq: 12
      };
    },
    subscribe() {
      return () => {};
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/sessions/session-1/events', {
    service,
    headers: { 'last-event-id': '11' }
  });
  await handleWebUiChatRuntimeRequest(ctx);
  assert.equal(requestedAfter, 11);
  assert.equal(ctx.res.statusCode, 200);
  assert.match(ctx.res.body, /id: 12/);
  assert.match(ctx.res.body, /event: turn\.started/);
  ctx.req.emit('close');
});

test('chat runtime event gap emits a snapshot reset before replay', async () => {
  const service = {
    async readEvents() {
      return {
        gap: true,
        snapshot: { sessionId: 'session-1', throughSeq: 40 },
        events: []
      };
    },
    subscribe() {
      return () => {};
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/sessions/session-1/events', { service });
  await handleWebUiChatRuntimeRequest(ctx);
  assert.match(ctx.res.body, /event: session\.snapshot\.reset/);
  assert.match(ctx.res.body, /"throughSeq":40/);
  ctx.req.emit('close');
});

test('chat runtime buffers live events during replay without losing or duplicating seq', async () => {
  let publish;
  const service = {
    subscribe(_sessionId, listener) {
      publish = listener;
      return () => {};
    },
    async readEvents() {
      publish({ seq: 12, type: 'timeline.item.delta', payload: { chunk: 'live' } });
      return {
        events: [
          { seq: 11, type: 'turn.started', payload: {} },
          { seq: 12, type: 'timeline.item.delta', payload: { chunk: 'replay' } }
        ]
      };
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/sessions/session-1/events', {
    service,
    headers: { 'last-event-id': '10' }
  });

  await handleWebUiChatRuntimeRequest(ctx);

  assert.equal((ctx.res.body.match(/id: 11/g) || []).length, 1);
  assert.equal((ctx.res.body.match(/id: 12/g) || []).length, 1);
  assert.ok(ctx.res.body.indexOf('id: 11') < ctx.res.body.indexOf('id: 12'));
  ctx.req.emit('close');
});

test('chat runtime artifact route returns scoped artifact bytes', async () => {
  const service = {
    async readArtifact(artifactId) {
      return { artifactId, contentType: 'text/plain', body: Buffer.from('output') };
    }
  };
  const ctx = createContext('GET', '/v0/webui/chat/artifacts/artifact-1', { service });
  await handleWebUiChatRuntimeRequest(ctx);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.headers['Content-Type'], 'text/plain');
  assert.equal(ctx.res.body, 'output');
});
