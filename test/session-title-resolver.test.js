'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  chooseBestThreadForSession,
  normalizeProjectPath,
  resolveAgentSessionTitles
} = require('../lib/cli/services/ai-cli/session-title-resolver');

test('normalizeProjectPath removes trailing slashes', () => {
  assert.equal(normalizeProjectPath('/work/ai_home///'), '/work/ai_home');
});

test('normalizeProjectPath maps Windows long cwd for the current platform', () => {
  const expected = process.platform === 'win32'
    ? 'C:\\Users\\madou\\projects\\feature\\ai_home'
    : '/mnt/c/Users/madou/projects/feature/ai_home';
  assert.equal(
    normalizeProjectPath('\\\\?\\C:\\Users\\madou\\projects\\feature\\ai_home\\'),
    expected
  );
});

test('chooseBestThreadForSession prefers thread created with the tmux session', () => {
  const selected = chooseBestThreadForSession(
    { created: 200 },
    [
      { id: 'old_active', title: '旧会话', createdAt: 100, updatedAt: 500 },
      { id: 'same_start', title: '同一窗口会话', createdAt: 201, updatedAt: 210 }
    ]
  );

  assert.equal(selected.id, 'same_start');
});

test('chooseBestThreadForSession falls back to active thread at tmux creation time', () => {
  const selected = chooseBestThreadForSession(
    { created: 300 },
    [
      { id: 'older', title: '旧会话', createdAt: 100, updatedAt: 200 },
      { id: 'active', title: '仍在更新的会话', createdAt: 250, updatedAt: 500 }
    ]
  );

  assert.equal(selected.id, 'active');
});

test('chooseBestThreadForSession does not reuse stale project titles for new sessions', () => {
  const selected = chooseBestThreadForSession(
    { created: 300 },
    [
      { id: 'stale', title: 'continue', createdAt: 100, updatedAt: 200 }
    ]
  );

  assert.equal(selected, null);
});

test('resolveAgentSessionTitles attaches codex agent title by project path', () => {
  const [session] = resolveAgentSessionTitles('codex', [{
    name: 'p-ai-home',
    created: 100,
    path: '/work/ai_home'
  }], {
    readCodexThreadRecords: () => [{
      id: 'thread_1',
      cwd: '/work/ai_home',
      title: '真实标题',
      createdAt: 101,
      updatedAt: 120
    }]
  });

  assert.equal(session.agentTitle, '真实标题');
  assert.equal(session.agentSessionId, 'thread_1');
});

test('resolveAgentSessionTitles assigns codex threads to tmux sessions one time only', () => {
  const sessions = resolveAgentSessionTitles('codex', [
    { name: 'p-ai-home', created: 300, path: '/work/ai_home' },
    { name: 'p-ai-home-2', created: 305, path: '/work/ai_home' },
    { name: 'p-ai-home-3', created: 306, path: '/work/ai_home' }
  ], {
    readCodexThreadRecords: () => [
      {
        id: 'thread-old',
        cwd: '/work/ai_home',
        title: '仍在更新的旧会话',
        createdAt: 250,
        updatedAt: 500
      },
      {
        id: 'thread-new',
        cwd: '/work/ai_home',
        title: '同一窗口会话',
        createdAt: 305,
        updatedAt: 306
      }
    ]
  });

  assert.deepEqual(sessions.map((session) => session.agentSessionId || ''), [
    'thread-old',
    'thread-new',
    ''
  ]);
  assert.deepEqual(sessions.map((session) => session.agentTitle || ''), [
    '仍在更新的旧会话',
    '同一窗口会话',
    ''
  ]);
});

test('resolveAgentSessionTitles prefers the active rollout opened by the pane process', () => {
  const [session] = resolveAgentSessionTitles('codex', [{
    name: 'p-ai-home',
    created: 300,
    path: '/work/ai_home',
    panePid: 12345
  }], {
    readCodexActiveSessionRecords: () => [{
      index: 0,
      rolloutPath: '/Users/model/.codex/sessions/2026/06/19/rollout-2026-06-19T23-45-33-019ee08f-143d-74d0-ba87-8447b04ac247.jsonl'
    }],
    readCodexThreadRecords: () => [
      {
        id: 'thread-old',
        cwd: '/work/ai_home',
        title: 'scoped commit & push',
        createdAt: 300,
        updatedAt: 310
      },
      {
        id: '019ee08f-143d-74d0-ba87-8447b04ac247',
        cwd: '/work/ai_home',
        title: 'aih codex sessions\n[aih] 选择要进入的持久会话（Enter=镜像进入，↑/↓=选择，q/Esc=退出）\n/work/ai_home\n> ⠿ 在用 GPT #1 scoped commit',
        createdAt: 900,
        updatedAt: 950
      }
    ]
  });

  assert.equal(session.agentTitle, 'aih codex sessions');
  assert.equal(session.agentSessionId, '019ee08f-143d-74d0-ba87-8447b04ac247');
});

test('resolveAgentSessionTitles derives codex title from rollout objective when state title is empty', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-title-resolver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexDir = path.join(root, '.codex');
  const rolloutPath = path.join(codexDir, 'sessions', '2026', '06', '19', 'rollout-2026-06-19T01-36-26-thread-new.jsonl');
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-new', cwd: '/work/ai_home' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<codex_internal_context source="goal">\n<objective>\n修复 sessions 选择器标题\n</objective>\n</codex_internal_context>'
          }]
        }
      })
    ].join('\n') + '\n',
    'utf8'
  );

  fs.mkdirSync(codexDir, { recursive: true });
  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      rollout_path TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  db.prepare(`
    INSERT INTO threads (
      id, cwd, title, first_user_message, created_at, updated_at,
      created_at_ms, updated_at_ms, rollout_path, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'thread-new',
    '/work/ai_home',
    '',
    '',
    200,
    220,
    200000,
    220000,
    rolloutPath,
    0
  );
  db.close();

  const [session] = resolveAgentSessionTitles('codex', [{
    name: 'p-ai-home',
    created: 200000,
    path: '/work/ai_home'
  }], {
    fs,
    hostHomeDir: root,
    DatabaseSync
  });

  assert.equal(session.agentTitle, '修复 sessions 选择器标题');
  assert.equal(session.agentSessionId, 'thread-new');
});

test('resolveAgentSessionTitles matches Windows state cwd with WSL session path', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-title-windows-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexDir = path.join(root, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      rollout_path TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  db.prepare(`
    INSERT INTO threads (
      id, cwd, title, first_user_message, created_at_ms, updated_at_ms, rollout_path, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'thread-win-cwd',
    '\\\\?\\C:\\Users\\madou\\projects\\feature\\ai_home',
    'Windows cwd 会话',
    '',
    200000,
    220000,
    '',
    0
  );
  db.close();

  const [session] = resolveAgentSessionTitles('codex', [{
    name: 'p-ai-home',
    created: 200000,
    path: '/mnt/c/Users/madou/projects/feature/ai_home'
  }], {
    fs,
    hostHomeDir: root,
    DatabaseSync
  });

  assert.equal(session.agentTitle, 'Windows cwd 会话');
  assert.equal(session.agentSessionId, 'thread-win-cwd');
});
