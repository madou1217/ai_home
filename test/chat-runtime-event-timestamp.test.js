'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

test('runtime prewarm events do not reorder a session, while activity events do', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-runtime-time-'));
  let now = 100;
  const store = openChatRuntimeStore({
    fs,
    aiHomeDir: root,
    historyCompaction: false,
    clock: () => now,
  });
  try {
    const created = store.createSession({
      sessionId: 'session-time',
      provider: 'codex',
      executionAccountRef: 'account-1',
      projectPath: '',
      policy: { workspaceMode: 'chat' },
    });
    assert.equal(created.updatedAt, 100);

    now = 200;
    store.appendEvent('session-time', {
      type: 'runtime.prewarm.started',
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: {},
    });
    const afterPrewarm = store.getSession('session-time');
    assert.equal(afterPrewarm.updatedAt, 100);
    assert.equal(afterPrewarm.lastEventSeq, 2);

    now = 300;
    store.appendEvent('session-time', {
      type: 'turn.started',
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: {},
    });
    const afterActivity = store.getSession('session-time');
    assert.equal(afterActivity.updatedAt, 300);
    assert.equal(afterActivity.lastEventSeq, 3);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
