'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  listChatSessions,
  readChatSession,
  saveChatSession,
  deleteChatSession,
} = require('../lib/server/webui-chat-store');

test('webui-chat-store CRUD operations', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-store-test-'));
  try {
    assert.deepEqual(listChatSessions(tmpHome), []);

    const session1 = {
      id: 'chat-1',
      title: '测试对话 1',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      updatedAt: 1000,
      mode: 'chat',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    };

    saveChatSession(session1, tmpHome);
    assert.equal(listChatSessions(tmpHome).length, 1);
    assert.deepEqual(readChatSession('chat-1', tmpHome), session1);

    const session2 = {
      id: 'chat-2',
      title: '测试对话 2',
      provider: 'codex',
      updatedAt: 2000,
      mode: 'chat',
      messages: [],
    };
    saveChatSession(session2, tmpHome);

    const list = listChatSessions(tmpHome);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'chat-2'); // updatedAt desc

    assert.equal(deleteChatSession('chat-1', tmpHome), true);
    assert.equal(readChatSession('chat-1', tmpHome), null);
    assert.equal(listChatSessions(tmpHome).length, 1);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
