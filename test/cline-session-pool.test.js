'use strict';

// cline 跨账号：每个账号一个库，读的时候池化归并 —— 不合并库、不复制行。
//
// 守两件事：
//   1) WebUI 不指定账号时能看到所有账号投影里的会话（历史 + 消息文件）；
//   2) 指定账号时只看该账号（原生身份判定不能串账号）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (_error) { DatabaseSync = null; }
const skip = DatabaseSync ? false : 'node:sqlite unavailable';

const { readClineProjects, resolveClineSessionPath } = require('../lib/sessions/session-reader-cline');

function withRoot(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-pool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fn({ root, aiHomeDir: path.join(root, 'aih'), hostHomeDir: path.join(root, 'home') });
}

function writeAccountDb(root, dataDir, rows) {
  const dbPath = path.join(dataDir, 'db', 'sessions.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at INTEGER, cwd TEXT, title TEXT, prompt TEXT, model TEXT, messages_path TEXT)');
  const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)');
  for (const row of rows) {
    insert.run(row.id, row.startedAt, row.cwd || '/repo', row.title || row.id, 'p', 'claude', '');
    const messageDir = path.join(dataDir, 'sessions', row.id);
    fs.mkdirSync(messageDir, { recursive: true });
    fs.writeFileSync(path.join(messageDir, row.id + '.messages.json'), JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello ' + row.id }], ts: row.startedAt }]
    }));
  }
  db.close();
  return dbPath;
}

test('不指定账号：三个账号库的会话一起出现（含消息读取）', { skip }, (t) => withRoot(t, ({ root, aiHomeDir, hostHomeDir }) => {
  writeAccountDb(root, path.join(hostHomeDir, '.cline', 'data'), [{ id: '1792050248852_a001', startedAt: 1000 }]);
  writeAccountDb(root, path.join(aiHomeDir, 'run', 'auth-projections', 'cline', 'acct_aaaaaaaaaaaaaaaaaaaa', '.cline', 'data'), [{ id: '1792050248853_a002', startedAt: 2000 }]);
  writeAccountDb(root, path.join(aiHomeDir, 'run', 'auth-projections', 'cline', 'acct_bbbbbbbbbbbbbbbbbbbb', '.cline', 'data'), [{ id: '1792050248854_a003', startedAt: 3000 }]);

  const projects = readClineProjects({ fs, path, aiHomeDir, hostHomeDir, DatabaseSync });
  const ids = projects.flatMap((project) => project.sessions.map((session) => session.id)).sort();
  assert.deepEqual(ids, ['1792050248852_a001', '1792050248853_a002', '1792050248854_a003']);

  // 另一个账号库里的会话，消息文件也能定位到（不需要把它复制到宿主）
  const messagePath = resolveClineSessionPath('1792050248854_a003', { fs, path, aiHomeDir, hostHomeDir });
  assert.ok(messagePath.includes('acct_bbbbbbbbbbbbbbbbbbbb'));
  assert.equal(fs.existsSync(messagePath), true);

  // 每个库仍然只有一份（没有生成任何副本）
  const dbs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'sessions.db') dbs.push(full);
    }
  };
  walk(root);
  assert.equal(dbs.length, 3);
}));

test('指定账号：只返回该账号的会话', { skip }, (t) => withRoot(t, ({ root, aiHomeDir, hostHomeDir }) => {
  writeAccountDb(root, path.join(hostHomeDir, '.cline', 'data'), [{ id: '1792050248852_a001', startedAt: 1000 }]);
  writeAccountDb(root, path.join(aiHomeDir, 'run', 'auth-projections', 'cline', 'acct_aaaaaaaaaaaaaaaaaaaa', '.cline', 'data'), [{ id: '1792050248853_a002', startedAt: 2000 }]);

  const projects = readClineProjects({ fs, path, aiHomeDir, hostHomeDir, accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', DatabaseSync });
  const ids = projects.flatMap((project) => project.sessions.map((session) => session.id));
  assert.deepEqual(ids, ['1792050248853_a002']);
}));
