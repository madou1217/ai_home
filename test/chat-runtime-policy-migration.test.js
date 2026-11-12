'use strict';

// 回归守卫：Chat / Work 现在只由 project_path 判定，policy.workspaceMode 必须从存量库中抹掉，
// 且不能顺手丢掉同一条 policy 里的其它字段。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CHAT_RUNTIME_SCHEMA, openChatRuntimeDatabase } = require('../lib/server/chat-runtime/database');

function insertSession(db, { sessionId, projectPath, policy }) {
  db.prepare(`
    INSERT INTO chat_runtime_sessions (
      session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
      capability_snapshot_json, policy_json, active_turn_json, last_event_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
  `).run(
    sessionId, 'codex', 'acct_test', projectPath, 'idle',
    JSON.stringify({}), JSON.stringify({}), JSON.stringify(policy), 1, 1,
  );
}

test('opening the runtime DB strips legacy policy.workspaceMode and keeps other policy fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workspace-mode-'));
  try {
    const dbPath = path.join(root, 'app-state.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec(CHAT_RUNTIME_SCHEMA);
    insertSession(seed, {
      sessionId: 'session-work', projectPath: '/tmp/project',
      policy: { approvalMode: 'bypass', workspaceMode: 'work', model: 'm1' },
    });
    insertSession(seed, {
      sessionId: 'session-chat', projectPath: '',
      policy: { approvalMode: 'confirm', workspaceMode: 'chat' },
    });
    seed.close();

    const db = openChatRuntimeDatabase({ fs, aiHomeDir: root });
    try {
      const rows = db.prepare('SELECT session_id, project_path, policy_json FROM chat_runtime_sessions ORDER BY session_id').all();
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const policy = JSON.parse(row.policy_json);
        assert.equal(Object.hasOwn(policy, 'workspaceMode'), false, row.session_id);
      }
      const work = JSON.parse(rows.find((row) => row.session_id === 'session-work').policy_json);
      assert.equal(work.approvalMode, 'bypass');
      assert.equal(work.model, 'm1');
      const chat = JSON.parse(rows.find((row) => row.session_id === 'session-chat').policy_json);
      assert.equal(chat.approvalMode, 'confirm');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
