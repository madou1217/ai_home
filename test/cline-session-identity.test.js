'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  CLINE_SESSION_ID_PATTERN,
  normalizeSessionId,
  extractClineSessionId,
  toEpochMs,
  resolveClineDataDir,
  readClineSessionRecords,
  matchClineSessionForLaunch
} = require('../lib/sessions/cline-session-store');
const { resolveAgentSessionTitles } = require('../lib/cli/services/ai-cli/session-title-resolver');

const SESSION_A = '1792050248852_or8f0';
const SESSION_B = '1792050249000_zzz11';
const SESSION_C = '1792050100000_old00';

const SESSIONS_SCHEMA = `CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  cwd TEXT,
  workspace_root TEXT,
  prompt TEXT
)`;

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-identity-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef = 'acct_00000000000000000001';
  const dataDir = path.join(aiHomeDir, 'run', 'auth-projections', 'cline', accountRef, '.cline', 'data');
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  return { root, aiHomeDir, accountRef, dataDir };
}

function writeSessionsDb(dbPath, rows) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SESSIONS_SCHEMA);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO sessions (session_id, pid, started_at, updated_at, status, cwd, workspace_root, prompt)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) {
      insert.run(
        row.session_id,
        row.pid || 0,
        row.started_at || '2026-10-15T00:00:00.000Z',
        row.updated_at || '2026-10-15T00:00:00.000Z',
        row.status || 'idle',
        row.cwd || '',
        row.workspace_root || row.cwd || '',
        row.prompt || ''
      );
    }
  } finally {
    db.close();
  }
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('session ids are only accepted in the observed cline shape', () => {
  assert.ok(CLINE_SESSION_ID_PATTERN.test(SESSION_A));
  assert.equal(normalizeSessionId(SESSION_A), SESSION_A);
  assert.equal(normalizeSessionId('not-a-session-id'), '');
  assert.equal(normalizeSessionId(''), '');
});

test('the session id is recoverable from resume argv (reboot chains keep their identity)', () => {
  assert.equal(extractClineSessionId(['-P', 'cline-pass', '--id', SESSION_A]), SESSION_A);
  assert.equal(extractClineSessionId(['--id=' + SESSION_B]), SESSION_B);
  assert.equal(extractClineSessionId(['--id', 'bogus']), '');
  assert.equal(extractClineSessionId(['-P', 'cline-pass']), '');
  assert.equal(extractClineSessionId(null), '');
});

test('timestamps normalize from ISO strings, seconds and milliseconds', () => {
  assert.equal(toEpochMs('2026-10-15T00:00:00.000Z'), Date.parse('2026-10-15T00:00:00.000Z'));
  assert.equal(toEpochMs(1792050248), 1792050248000);
  assert.equal(toEpochMs(1792050248852), 1792050248852);
  assert.equal(toEpochMs(''), 0);
});

test('records come from the account sandbox sessions.db', () => {
  const tree = makeTree();
  try {
    writeSessionsDb(path.join(tree.dataDir, 'db', 'sessions.db'), [
      {
        session_id: SESSION_A,
        started_at: '2026-10-15T07:44:08.855Z',
        cwd: '/work/alpha',
        prompt: '<user_input mode="act">修复 bug</user_input>'
      }
    ]);
    const dataDir = resolveClineDataDir({
      aiHomeDir: tree.aiHomeDir,
      runtimeScope: tree.accountRef,
      path
    });
    assert.equal(dataDir, tree.dataDir);
    const records = readClineSessionRecords({ fs, path, dataDir, DatabaseSync });
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, SESSION_A);
    assert.equal(records[0].cwd, '/work/alpha');
    assert.equal(records[0].title, '修复 bug');
    assert.equal(records[0].startedAtMs, Date.parse('2026-10-15T07:44:08.855Z'));
  } finally {
    cleanup(tree.root);
  }
});

test('the matcher picks the closest session in the same cwd inside the tolerance window', () => {
  const startedAt = Date.parse('2026-10-15T07:44:08.855Z');
  const records = [
    { sessionId: SESSION_A, cwd: '/work/alpha', startedAtMs: startedAt + 5000, title: 'a' },
    { sessionId: SESSION_B, cwd: '/work/alpha', startedAtMs: startedAt + 120000, title: 'b' },
    { sessionId: SESSION_C, cwd: '/work/beta', startedAtMs: startedAt + 1000, title: 'c' }
  ];
  const match = matchClineSessionForLaunch({ records, cwd: '/work/alpha', startedAt, toleranceSeconds: 300 });
  assert.equal(match.sessionId, SESSION_A);

  // 已被别的 pane 认领的不再分配。
  const second = matchClineSessionForLaunch({
    records,
    cwd: '/work/alpha',
    startedAt,
    toleranceSeconds: 300,
    excludeSessionIds: new Set([SESSION_A])
  });
  assert.equal(second.sessionId, SESSION_B);

  // 容差外 / cwd 不同 / 没有 pane 时间 → 不猜。
  assert.equal(matchClineSessionForLaunch({ records, cwd: '/work/alpha', startedAt: startedAt + 3600000 }), null);
  assert.equal(matchClineSessionForLaunch({ records, cwd: '/work/gamma', startedAt }), null);
  assert.equal(matchClineSessionForLaunch({ records, cwd: '/work/alpha', startedAt: 0 }), null);
});

test('aih session rows for cline carry the cline session identity', () => {
  const tree = makeTree();
  try {
    const startedSeconds = Math.floor(Date.parse('2026-10-15T07:44:08.855Z') / 1000);
    writeSessionsDb(path.join(tree.dataDir, 'db', 'sessions.db'), [
      { session_id: SESSION_A, started_at: '2026-10-15T07:44:08.855Z', cwd: '/work/alpha', prompt: '做一件事' },
      { session_id: SESSION_C, started_at: '2026-10-15T06:00:00.000Z', cwd: '/work/beta', prompt: '很久以前' }
    ]);
    const rows = [
      { name: 'p-alpha-1', path: '/work/alpha', created: startedSeconds + 2 },
      { name: 'p-alpha-2', path: '/work/alpha', created: startedSeconds + 200000 },
      { name: 'p-beta-9', path: '/work/beta', created: startedSeconds }
    ];
    const decorated = resolveAgentSessionTitles('cline', rows, {
      fs,
      path,
      aiHomeDir: tree.aiHomeDir,
      runtimeScope: tree.accountRef,
      DatabaseSync
    });
    assert.equal(decorated[0].agentSessionId, SESSION_A);
    assert.equal(decorated[0].agentTitle, '做一件事');
    // 第二个 pane 与 SESSION_A 差 200000s（远超容差）→ 不猜。
    assert.equal(decorated[1].agentSessionId, undefined);
    // 没有匹配但注册表里记着身份（恢复过的 pane）→ 仍然显示同一个会话身份。
    const fromRegistry = resolveAgentSessionTitles('cline', [rows[1]], {
      fs,
      path,
      aiHomeDir: tree.aiHomeDir,
      runtimeScope: tree.accountRef,
      DatabaseSync,
      registryEntries: [{ session: 'p-alpha-2', nativeSessionId: SESSION_B, forwardArgs: ['--id', SESSION_B] }]
    });
    assert.equal(fromRegistry[0].agentSessionId, SESSION_B);
  } finally {
    cleanup(tree.root);
  }
});

test('the closest pane wins a shared session and the other one gets nothing', () => {
  const tree = makeTree();
  try {
    const sessionStartedMs = Date.parse('2026-10-15T07:44:08.855Z');
    writeSessionsDb(path.join(tree.dataDir, 'db', 'sessions.db'), [
      { session_id: SESSION_A, started_at: '2026-10-15T07:44:08.855Z', cwd: '/work/alpha', prompt: '目标会话' }
    ]);
    // 两个 pane 的 cwd 相同、都在容差内：近的那个（+32s）必须拿到身份，
    // 远的（+217s）不能——顺序敏感的贪心会让先遍历到的 pane 抢走它。
    const rows = [
      { name: 'p-alpha-far', path: '/work/alpha', created: Math.floor(sessionStartedMs / 1000) - 217 },
      { name: 'p-alpha-near', path: '/work/alpha', created: Math.floor(sessionStartedMs / 1000) + 32 }
    ];
    const decorated = resolveAgentSessionTitles('cline', rows, {
      fs,
      path,
      aiHomeDir: tree.aiHomeDir,
      runtimeScope: tree.accountRef,
      DatabaseSync
    });
    assert.equal(decorated[0].agentSessionId, undefined);
    assert.equal(decorated[1].agentSessionId, SESSION_A);
    assert.equal(decorated[1].agentSessionIdSource, 'store');
  } finally {
    cleanup(tree.root);
  }
});

test('non-cline providers are untouched by the cline resolver', () => {
  const rows = [{ name: 'p-1', path: '/work/alpha', created: 1792050248 }];
  assert.deepEqual(resolveAgentSessionTitles('kiro', rows, {}), rows);
});
