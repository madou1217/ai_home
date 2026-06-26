const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  hasEarlyUserMessageEvent,
  repairCodexSessionVisibility
} = require('../lib/cli/services/ai-cli/codex-session-visibility-repair');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-session-visibility-'));
}

function getDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function writeStateDb(DatabaseSync, dbPath, row) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
      source, model_provider, cwd, title, first_user_message, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.rolloutPath,
    1779363582,
    1779438937,
    1779363582469,
    1779438937280,
    'cli',
    'aih_1',
    row.cwd,
    row.title,
    row.firstUserMessage,
    0
  );
  db.close();
}

function writeStateDbRows(DatabaseSync, dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      archived INTEGER DEFAULT 0
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
      source, model_provider, cwd, title, first_user_message, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  rows.forEach((row, index) => {
    insert.run(
      row.id,
      row.rolloutPath,
      1779363582 + index,
      1779438937 + index,
      1779363582469 + index,
      1779438937280 + index,
      row.source || 'cli',
      row.modelProvider,
      row.cwd,
      row.title,
      row.firstUserMessage || row.title,
      row.archived || 0
    );
  });
  db.close();
}

function delayedUserMessageRollout(threadId) {
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-21T11:40:39.345Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-21T11:39:42.469Z',
        cwd: '/tmp/project',
        source: 'cli',
        model_provider: 'aih_1'
      }
    })
  ];
  for (let i = 0; i < 220; i += 1) {
    lines.push(JSON.stringify({
      timestamp: '2026-05-21T11:40:39.353Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: `turn-${i}` }
    }));
  }
  lines.push(JSON.stringify({
    timestamp: '2026-05-21T11:49:33.371Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'please continue', images: [], local_images: [], text_elements: [] }
  }));
  return `${lines.join('\n')}\n`;
}

test('detects whether rollout has an early user_message event', () => {
  const early = [
    JSON.stringify({ type: 'session_meta', payload: { id: 't1' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } })
  ].join('\n');
  const late = delayedUserMessageRollout('019e4a55-9205-7e33-95d5-90e1077e5795');

  assert.equal(hasEarlyUserMessageEvent(early), true);
  assert.equal(hasEarlyUserMessageEvent(late), false);
});

test('codex session visibility diagnostic is read-only', (t) => {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return;

  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codexHome = path.join(root, '.codex');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '21');
  const threadId = '019e4a55-9205-7e33-95d5-90e1077e5795';
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-21T19-39-42-${threadId}.jsonl`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(rolloutPath, delayedUserMessageRollout(threadId), 'utf8');
  writeStateDb(DatabaseSync, path.join(codexHome, 'state_5.sqlite'), {
    id: threadId,
    rolloutPath,
    cwd: '/tmp/project',
    title: 'please continue',
    firstUserMessage: 'please continue'
  });

  const originalRolloutText = fs.readFileSync(rolloutPath, 'utf8');
  const first = repairCodexSessionVisibility(codexHome, {
    fs,
    path,
    cwd: '/tmp/project',
    DatabaseSync
  });

  assert.equal(first.scanned, 1);
  assert.equal(first.indexAdded, 0);
  assert.equal(first.rolloutPatched, 0);
  assert.equal(first.providerAligned, 0);
  assert.equal(first.reason, 'read_only_diagnostic');
  assert.equal(fs.existsSync(path.join(codexHome, 'session_index.jsonl')), false);
  assert.equal(fs.readFileSync(rolloutPath, 'utf8'), originalRolloutText);

  const second = repairCodexSessionVisibility(codexHome, {
    fs,
    path,
    cwd: '/tmp/project',
    DatabaseSync
  });
  assert.equal(second.indexAdded, 0);
  assert.equal(second.rolloutPatched, 0);
});

test('codex session visibility diagnostic does not rewrite providers', (t) => {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return;

  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codexHome = path.join(root, '.codex');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '22');
  fs.mkdirSync(sessionDir, { recursive: true });
  const cwd = '/tmp/project';
  const rows = [
    { id: 'thread-current', modelProvider: 'aih_1', source: 'cli', cwd, title: 'current' },
    { id: 'thread-openai', modelProvider: 'openai', source: 'cli', cwd, title: 'openai' },
    { id: 'thread-vscode', modelProvider: 'aih_10', source: 'vscode', cwd, title: 'vscode' },
    { id: 'thread-exec', modelProvider: 'openai', source: 'exec', cwd, title: 'exec' },
    { id: 'thread-other-cwd', modelProvider: 'openai', source: 'cli', cwd: '/tmp/other', title: 'other' }
  ].map((row) => {
    const rolloutPath = path.join(sessionDir, `rollout-2026-05-22T12-00-00-${row.id}.jsonl`);
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: row.id, cwd: row.cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: row.title } }),
      ''
    ].join('\n'), 'utf8');
    return { ...row, rolloutPath };
  });
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  fs.mkdirSync(codexHome, { recursive: true });
  writeStateDbRows(DatabaseSync, dbPath, rows);

  const result = repairCodexSessionVisibility(codexHome, {
    fs,
    path,
    cwd,
    currentModelProvider: 'aih_1',
    DatabaseSync
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.providerAligned, 0);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const providers = db.prepare('SELECT id, model_provider FROM threads ORDER BY id').all()
    .reduce((acc, row) => ({ ...acc, [row.id]: row.model_provider }), {});
  db.close();

  assert.equal(providers['thread-current'], 'aih_1');
  assert.equal(providers['thread-openai'], 'openai');
  assert.equal(providers['thread-vscode'], 'aih_10');
  assert.equal(providers['thread-exec'], 'openai');
  assert.equal(providers['thread-other-cwd'], 'openai');
});
