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
