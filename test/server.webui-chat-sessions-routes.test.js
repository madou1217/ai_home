'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  handleGetChatSessionsRequest,
  handleGetSingleChatSessionRequest,
  handleCreateChatSessionRequest,
  handleDeleteChatSessionRequest,
} = require('../lib/server/webui-chat-sessions-routes');

test('webui-chat-sessions-routes handle endpoints correctly', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-routes-test-'));
  try {
    let responseStatus = 0;
    let responseBody = null;

    const createCtx = (method, pathname, body = null) => ({
      method,
      pathname,
      hostHomeDir: tmpHome,
      readRequestBody: async () => body ? Buffer.from(JSON.stringify(body)) : Buffer.from(''),
      writeJson: (res, status, data) => {
        responseStatus = status;
        responseBody = data;
      },
      res: {},
      req: { headers: { host: '127.0.0.1:9527' }, url: pathname }
    });

    // 1. List initially empty
    await handleGetChatSessionsRequest(createCtx('GET', '/v0/webui/chat-sessions'));
    assert.equal(responseStatus, 200);
    assert.deepEqual(responseBody.sessions, []);

    // 2. Create session
    await handleCreateChatSessionRequest(createCtx('POST', '/v0/webui/chat-sessions', {
      id: 'session-c1',
      title: '我的新对话',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
    }));
    assert.equal(responseStatus, 201);
    assert.equal(responseBody.session.id, 'session-c1');
    assert.equal(responseBody.session.mode, 'chat');

    // 3. Get single session
    await handleGetSingleChatSessionRequest(createCtx('GET', '/v0/webui/chat-sessions/session-c1'));
    assert.equal(responseStatus, 200);
    assert.equal(responseBody.session.title, '我的新对话');

    // 4. Delete session
    await handleDeleteChatSessionRequest(createCtx('DELETE', '/v0/webui/chat-sessions/session-c1'));
    assert.equal(responseStatus, 200);
    assert.equal(responseBody.deleted, true);

    // 5. Get after delete -> 404
    await handleGetSingleChatSessionRequest(createCtx('GET', '/v0/webui/chat-sessions/session-c1'));
    assert.equal(responseStatus, 404);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function createRuntimeCtx(pathname, deps) {
  const state = { status: 0, body: null };
  const ctx = {
    method: 'DELETE',
    pathname,
    hostHomeDir: os.tmpdir(),
    deps,
    readRequestBody: async () => Buffer.from(''),
    writeJson: (_res, status, body) => {
      state.status = status;
      state.body = body;
    },
    res: {},
    req: { headers: { host: '127.0.0.1:9527' }, url: pathname }
  };
  return { ctx, state };
}

test('canonical chat session delete removes the record instead of archiving it', async () => {
  const deleted = [];
  const archived = [];
  const runtime = {
    store: {
      getSession: (sessionId) => (sessionId === 'session-runtime-1'
        ? { sessionId, policy: { workspaceMode: 'chat' } } : null),
      updatePolicy: (sessionId, patch) => archived.push([sessionId, patch])
    },
    async deleteSession(sessionId) { deleted.push(sessionId); }
  };
  const { ctx, state } = createRuntimeCtx('/v0/webui/chat-sessions/session-runtime-1', {
    chatRuntimeService: runtime
  });

  assert.equal(await handleDeleteChatSessionRequest(ctx), true);
  assert.equal(state.status, 200);
  assert.equal(state.body.deleted, true);
  assert.deepEqual(deleted, ['session-runtime-1']);
  assert.deepEqual(archived, []);
});

test('canonical chat session delete reports the busy contract instead of a 500', async () => {
  const runtime = {
    store: {
      getSession: () => ({ sessionId: 'session-busy', policy: { workspaceMode: 'chat' } })
    },
    async deleteSession() {
      const error = new Error('chat_session_busy');
      error.code = 'chat_session_busy';
      error.statusCode = 409;
      throw error;
    }
  };
  const { ctx, state } = createRuntimeCtx('/v0/webui/chat-sessions/session-busy', {
    chatRuntimeService: runtime
  });

  await handleDeleteChatSessionRequest(ctx);
  assert.equal(state.status, 409);
  assert.equal(state.body.error, 'chat_session_busy');
});

test('canonical chat session delete falls back to archiving without a delete-capable runtime', async () => {
  const archived = [];
  const runtime = {
    store: {
      getSession: () => ({ sessionId: 'session-old-runtime', policy: { workspaceMode: 'chat' } }),
      updatePolicy: (sessionId, patch) => archived.push([sessionId, patch])
    }
  };
  const { ctx, state } = createRuntimeCtx('/v0/webui/chat-sessions/session-old-runtime', {
    chatRuntimeService: runtime
  });

  await handleDeleteChatSessionRequest(ctx);
  assert.equal(state.status, 200);
  assert.equal(state.body.deleted, true);
  assert.deepEqual(archived, [['session-old-runtime', { archived: true }]]);
});
