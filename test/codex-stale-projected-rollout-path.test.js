'use strict';

// aih 每次启动 codex 都用临时投影目录当 CODEX_HOME，codex 把投影内路径写进 threads.rollout_path；
// 投影删除后 resume 报 "no rollout found for thread id"，而 rollout 文件其实在共享会话存储里。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { repairStaleProjectedRolloutPaths } = require('../lib/server/codex-app-server-stdio-proxy-rollout');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-stale-rollout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'host', '.codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '09', '30');
  fs.mkdirSync(sessions, { recursive: true });
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
  return { root, codexHome, sessions, db };
}

test('a thread recorded under a deleted projection is pointed back at the shared session store', (t) => {
  const { root, codexHome, sessions, db } = setup(t);
  const id = '01a0f2a8-11fa-7bd0-9f8c-d37dcac2d039';
  const fileName = `rollout-2026-09-30T22-11-36-${id}.jsonl`;
  fs.writeFileSync(path.join(sessions, fileName), '{}\n');
  const stale = path.join(root, 'aih-auth-codex-acct_x-frEhxx', '.codex', 'sessions', '2026', '09', '30', fileName);
  const liveProjection = path.join(root, 'aih-auth-codex-acct_x-live', '.codex', 'sessions', '2026', '09', '30');
  fs.mkdirSync(liveProjection, { recursive: true });
  fs.writeFileSync(path.join(liveProjection, 'rollout-live-thread-2.jsonl'), '{}\n');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(id, stale);
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-2', path.join(liveProjection, 'rollout-live-thread-2.jsonl'));
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-3', stale.replace(id, 'thread-3'));
  db.close();

  const result = repairStaleProjectedRolloutPaths({ fs, codexHome, DatabaseSync });

  assert.equal(result.repaired, 1);
  assert.equal(result.failed, 1);
  const check = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  const rows = Object.fromEntries(check.prepare('SELECT id, rollout_path FROM threads').all().map((row) => [row.id, row.rollout_path]));
  check.close();
  assert.equal(rows[id], path.join(fs.realpathSync(path.join(codexHome, 'sessions')), '2026', '09', '30', fileName));
  // 仍存在的投影路径（正在运行的会话）不动；共享存储里也找不到的不乱改。
  assert.equal(rows['thread-2'], path.join(liveProjection, 'rollout-live-thread-2.jsonl'));
  assert.equal(rows['thread-3'], stale.replace(id, 'thread-3'));
});

test('a single thread can be repaired right before it is resumed', (t) => {
  const { root, codexHome, sessions, db } = setup(t);
  const id = 'thread-resume';
  const fileName = `rollout-2026-09-30T10-00-00-${id}.jsonl`;
  fs.writeFileSync(path.join(sessions, fileName), '{}\n');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(id, path.join(root, 'gone', '.codex', 'sessions', '2026', '09', '30', fileName));
  db.close();
  const result = repairStaleProjectedRolloutPaths({ fs, codexHome, DatabaseSync, threadId: id });
  assert.equal(result.repaired, 1);
});
