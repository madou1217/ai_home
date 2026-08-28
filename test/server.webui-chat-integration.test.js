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
  appendMessageToChatSession,
} = require('../lib/server/webui-chat-store');

test('pure chat store saves and retrieves sessions without projectPath', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-integration-test-'));
  try {
    const session = {
      id: 'chat-standalone-1',
      title: '关于React优化的讨论',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      mode: 'chat',
      updatedAt: 1234567,
      messages: [
        { role: 'user', content: '如何优化React重渲染？' },
        { role: 'assistant', content: '可以使用useMemo、useCallback以及React.memo进行优化。' }
      ]
    };

    saveChatSession(session, tmpHome);
    const read = readChatSession('chat-standalone-1', tmpHome);
    assert.ok(read);
    assert.equal(read.mode, 'chat');
    assert.equal(read.messages.length, 2);

    appendMessageToChatSession('chat-standalone-1', '那还有其他方案吗？', '还可以进行状态下沉和虚拟列表。', {}, tmpHome);
    const updated = readChatSession('chat-standalone-1', tmpHome);
    assert.equal(updated.messages.length, 4);
    assert.equal(updated.messages[2].content, '那还有其他方案吗？');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
