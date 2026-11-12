'use strict';

// Chat / Work 只由 project_path 判定：chat 列表过滤必须落在 project_path = ''，
// 而不是任何 policy 字段；新会话的 policy 里也不该再出现 workspaceMode。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { isChatSession } = require('../lib/server/chat-runtime/chat-harness-policy');

test('chatOnly filter uses project_path and policies stay free of workspaceMode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-only-filter-'));
  const store = openChatRuntimeStore({ fs, aiHomeDir: root, historyCompaction: false });
  try {
    const chat = store.createSession({
      sessionId: 'chat-1', provider: 'codex', executionAccountRef: 'gateway',
      projectPath: '', policy: { approvalMode: 'confirm' },
    });
    store.createSession({
      sessionId: 'work-1', provider: 'codex', executionAccountRef: 'acct_test',
      projectPath: '/tmp/project', policy: { approvalMode: 'bypass' },
    });

    assert.equal(isChatSession(chat), true);
    assert.equal(Object.hasOwn(chat.policy, 'workspaceMode'), false);
    assert.deepEqual(store.listSessions({ chatOnly: true }).map((session) => session.sessionId), ['chat-1']);
    assert.equal(store.listSessions({}).length, 2);
  } finally {
    store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
