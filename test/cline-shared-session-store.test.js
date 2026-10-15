'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureClineSharedSessionState,
  CLINE_SHARED_DIR_ENTRIES,
  CLINE_SHARED_DB_FILES,
  CLINE_SHARED_DB_SIDECARS
} = require('../lib/cli/services/ai-cli/launch-profile/cline-shared-session-store');

const SESSIONS_SCHEMA = `CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'cli',
  pid INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  cwd TEXT,
  messages_path TEXT,
  updated_at TEXT NOT NULL DEFAULT ''
)`;

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-shared-test-'));
  const sandboxDir = path.join(root, 'sandbox');
  const hostHomeDir = path.join(root, 'host');
  fs.mkdirSync(path.join(sandboxDir, '.cline', 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(hostHomeDir, '.cline', 'data', 'db'), { recursive: true });
  return { root, sandboxDir, hostHomeDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function isLink(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch (_error) {
    return false;
  }
}

function projectionPath(tree, ...segments) {
  return path.join(tree.sandboxDir, '.cline', ...segments);
}

function sharedPath(tree, ...segments) {
  return path.join(tree.hostHomeDir, '.cline', ...segments);
}

function writeSessionsDb(dbPath, rows) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SESSIONS_SCHEMA);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO sessions (session_id, pid, started_at, status, cwd, messages_path, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) {
      insert.run(
        row.session_id,
        row.pid || 0,
        row.started_at || '2026-10-15T00:00:00.000Z',
        row.status || 'idle',
        row.cwd || '/work',
        row.messages_path || '',
        row.updated_at || '2026-10-15T00:00:00.000Z'
      );
    }
  } finally {
    db.close();
  }
}

function readSessionIds(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT session_id FROM sessions ORDER BY session_id').all().map((row) => row.session_id);
  } finally {
    db.close();
  }
}

test('fresh projection: session store entries are linked into the host store', () => {
  const tree = makeTree();
  try {
    const summary = ensureClineSharedSessionState(tree);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.deferred, '');
    assert.equal(summary.adopted, 0);
    for (const segments of CLINE_SHARED_DIR_ENTRIES) {
      assert.ok(isLink(projectionPath(tree, ...segments)), `${segments.join('/')} link`);
      assert.ok(fs.existsSync(sharedPath(tree, ...segments)), `${segments.join('/')} shared dir`);
    }
    for (const segments of CLINE_SHARED_DB_FILES) {
      assert.ok(isLink(projectionPath(tree, ...segments)), `${segments.join('/')} link`);
    }
    for (const segments of CLINE_SHARED_DB_SIDECARS) {
      assert.ok(isLink(projectionPath(tree, ...segments)), `${segments.join('/')} dangling link`);
    }
    // 幂等：再跑一次零新增链接、零错误。
    const again = ensureClineSharedSessionState(tree);
    assert.deepEqual(again.errors, []);
    assert.equal(again.linked, 0);
  } finally {
    cleanup(tree.root);
  }
});

test('credentials and caches inside data/ are never linked', () => {
  const tree = makeTree();
  try {
    fs.mkdirSync(projectionPath(tree, 'data', 'settings'), { recursive: true });
    fs.writeFileSync(projectionPath(tree, 'data', 'settings', 'providers.json'), '{"providers":{}}');
    fs.writeFileSync(projectionPath(tree, 'data', 'secrets.json'), '{"apiKey":"secret"}');
    fs.mkdirSync(projectionPath(tree, 'data', 'logs'), { recursive: true });
    ensureClineSharedSessionState(tree);
    assert.ok(!isLink(projectionPath(tree, 'data', 'settings')));
    assert.ok(!isLink(projectionPath(tree, 'data', 'secrets.json')));
    assert.ok(!isLink(projectionPath(tree, 'data', 'logs')));
    assert.ok(!fs.existsSync(sharedPath(tree, 'data', 'secrets.json')));
    assert.equal(fs.readFileSync(projectionPath(tree, 'data', 'secrets.json'), 'utf8'), '{"apiKey":"secret"}');
  } finally {
    cleanup(tree.root);
  }
});

test('real projection history is adopted into the host store, never discarded', () => {
  const tree = makeTree();
  try {
    // 投影：两个会话目录 + 两行历史；宿主：其中一个会话与一行历史已经存在。
    fs.mkdirSync(projectionPath(tree, 'data', 'sessions', 'a_1'), { recursive: true });
    fs.mkdirSync(projectionPath(tree, 'data', 'sessions', 'b_2'), { recursive: true });
    fs.writeFileSync(projectionPath(tree, 'data', 'sessions', 'a_1', 'a_1.messages.json'), '["projection-a"]');
    fs.writeFileSync(projectionPath(tree, 'data', 'sessions', 'b_2', 'b_2.messages.json'), '["projection-b"]');
    writeSessionsDb(projectionPath(tree, 'data', 'db', 'sessions.db'), [
      { session_id: 'a_1', status: 'completed' },
      { session_id: 'b_2', status: 'completed' }
    ]);
    fs.mkdirSync(sharedPath(tree, 'data', 'sessions', 'a_1'), { recursive: true });
    fs.writeFileSync(sharedPath(tree, 'data', 'sessions', 'a_1', 'a_1.messages.json'), '["host-a"]');
    writeSessionsDb(sharedPath(tree, 'data', 'db', 'sessions.db'), [{ session_id: 'a_1', status: 'idle' }]);

    const summary = ensureClineSharedSessionState(tree);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.deferred, '');
    assert.ok(summary.adopted >= 2, `adopted=${summary.adopted}`);
    assert.ok(isLink(projectionPath(tree, 'data', 'sessions')));
    assert.ok(isLink(projectionPath(tree, 'data', 'db', 'sessions.db')));
    // 宿主的既有内容不被覆盖，缺失的被搬过去。
    assert.equal(fs.readFileSync(sharedPath(tree, 'data', 'sessions', 'a_1', 'a_1.messages.json'), 'utf8'), '["host-a"]');
    assert.equal(fs.readFileSync(sharedPath(tree, 'data', 'sessions', 'b_2', 'b_2.messages.json'), 'utf8'), '["projection-b"]');
    // 历史按主键并集：宿主原有 a_1 保留自己的状态，投影新增 b_2。
    assert.deepEqual(readSessionIds(sharedPath(tree, 'data', 'db', 'sessions.db')), ['a_1', 'b_2']);
    const db = new DatabaseSync(sharedPath(tree, 'data', 'db', 'sessions.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('a_1').status, 'idle');
    } finally {
      db.close();
    }
  } finally {
    cleanup(tree.root);
  }
});

test('a live projection session defers the whole switch until the next launch', () => {
  const tree = makeTree();
  try {
    fs.mkdirSync(projectionPath(tree, 'data', 'sessions', 'live_1'), { recursive: true });
    writeSessionsDb(projectionPath(tree, 'data', 'db', 'sessions.db'), [{ session_id: 'live_1', pid: 4242, status: 'running' }]);
    const summary = ensureClineSharedSessionState({ ...tree, isPidAlive: () => true });
    assert.equal(summary.deferred, 'live-session');
    assert.equal(summary.linked, 0);
    assert.ok(!isLink(projectionPath(tree, 'data', 'sessions')));
    assert.ok(fs.existsSync(projectionPath(tree, 'data', 'db', 'sessions.db')));
    // 进程结束后下次启动即可接管。
    const next = ensureClineSharedSessionState({ ...tree, isPidAlive: () => false });
    assert.equal(next.deferred, '');
    assert.ok(isLink(projectionPath(tree, 'data', 'sessions')));
    assert.deepEqual(readSessionIds(sharedPath(tree, 'data', 'db', 'sessions.db')), ['live_1']);
  } finally {
    cleanup(tree.root);
  }
});

test('fail-closed when the sandbox already is the host home', () => {
  const tree = makeTree();
  try {
    const summary = ensureClineSharedSessionState({ sandboxDir: tree.sandboxDir, hostHomeDir: tree.sandboxDir });
    assert.equal(summary.linked, 0);
    assert.equal(summary.skipped, 'projection-is-shared-root');
    assert.ok(!isLink(projectionPath(tree, 'data', 'sessions')));
  } finally {
    cleanup(tree.root);
  }
});

test('a host db without the sessions table blocks the switch instead of guessing', () => {
  const tree = makeTree();
  try {
    fs.mkdirSync(projectionPath(tree, 'data', 'sessions', 'x_1'), { recursive: true });
    writeSessionsDb(projectionPath(tree, 'data', 'db', 'sessions.db'), [{ session_id: 'x_1' }]);
    fs.writeFileSync(sharedPath(tree, 'data', 'db', 'sessions.db'), '');
    const summary = ensureClineSharedSessionState(tree);
    assert.ok(
      summary.deferred === 'shared-db-schema-mismatch' || summary.deferred.startsWith('adopt-error'),
      `deferred=${summary.deferred}`
    );
    assert.equal(summary.linked, 0);
    assert.ok(!isLink(projectionPath(tree, 'data', 'db', 'sessions.db')));
    assert.ok(fs.existsSync(projectionPath(tree, 'data', 'db', 'sessions.db')));
    assert.ok(fs.existsSync(projectionPath(tree, 'data', 'sessions', 'x_1')));
  } finally {
    cleanup(tree.root);
  }
});

test('removing the account projection leaves the host shared store intact', () => {
  const tree = makeTree();
  try {
    fs.mkdirSync(projectionPath(tree, 'data', 'sessions', 'keep_1'), { recursive: true });
    fs.writeFileSync(projectionPath(tree, 'data', 'sessions', 'keep_1', 'keep_1.messages.json'), '["keep"]');
    ensureClineSharedSessionState(tree);
    assert.ok(fs.existsSync(sharedPath(tree, 'data', 'sessions', 'keep_1', 'keep_1.messages.json')));
    fs.rmSync(path.join(tree.sandboxDir, '.cline'), { recursive: true, force: true });
    assert.ok(fs.existsSync(sharedPath(tree, 'data', 'sessions', 'keep_1', 'keep_1.messages.json')));
  } finally {
    cleanup(tree.root);
  }
});
