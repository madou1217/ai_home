'use strict';

// 布局迁移 P2：WebUI chat 代理（opencode-session-store）必须按布局写。
// 真机取证动机（2026-10-16，opencode 2.0.29）：
//   1. 迁移后的库里 `session_message.session_id` 有 FK → `session_v2(id)`（node:sqlite 默认强制），
//      旧写入器给「只存在于旧 `session` 表」的新会话写 session_message 行 → 直接
//      `FOREIGN KEY constraint failed`，WebUI 新会话整个创建失败；
//   2. 即便绕过 FK，写进旧表的新会话对 opencode 2.x 也不可见（旧表迁移只跑一次）；
//   3. 已存在会话必须写它自己所在的布局（消息跨代分裂会让任一侧读取器只看到半段对话）。
// 本文件用带 FK 的测试 schema 钉住这三条。

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../lib/sessions/opencode-session-store');

function makeHome(prefix, t) {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(hostHome, '.local', 'share', 'opencode'), { recursive: true });
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  return hostHome;
}

function openDb(hostHome) {
  return store.openOpenCodeDb(hostHome, { readOnly: false });
}

function loadSessionReaderForHome(t, hostHome) {
  const previousRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHome;
  delete require.cache[require.resolve('../lib/sessions/session-reader')];
  const reader = require('../lib/sessions/session-reader');
  t.after(() => {
    if (previousRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = previousRealHome;
    delete require.cache[require.resolve('../lib/sessions/session-reader')];
  });
  return reader;
}

test('两代并存库：新会话写 session_v2/session_message（FK 满足），旧表零写入，reader 可读回', (t) => {
  const hostHome = makeHome('aih-oc-write-v2-', t);
  store.ensureOpenCodeSessionTestSchema(hostHome);
  const db = openDb(hostHome);

  // 先证明 fixture 真的在强制 FK（否则本用例守不住真机上那个回归）。
  assert.throws(
    () => db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('msg_orphan', 'ses_not_in_v2', 'user', 1, 1, '{}', 0),
    /FOREIGN KEY constraint failed/,
    'fixture 必须强制 session_message → session_v2 的 FK'
  );

  const turn = store.beginOpenCodeChatTurn({
    hostHome,
    projectPath: '/tmp/demo',
    prompt: '新会话写在哪一代',
    model: 'opencode-go/glm-5.2',
    nowMs: 1000
  });
  assert.equal(turn.created, true);
  assert.equal(turn.directory, '/tmp/demo');

  const v2Session = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(turn.sessionId);
  assert.ok(v2Session, '新会话落在 session_v2');
  assert.equal(v2Session.version, 'aih-webui');
  assert.equal(v2Session.directory, '/tmp/demo');
  assert.equal(v2Session.title, '新会话写在哪一代');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').get(turn.sessionId).n, 0, '旧会话表零写入');

  const userRows = db.prepare('SELECT * FROM session_message WHERE session_id = ? ORDER BY seq').all(turn.sessionId);
  assert.equal(userRows.length, 1);
  assert.equal(userRows[0].type, 'user');
  assert.equal(userRows[0].seq, 0);
  assert.deepEqual(JSON.parse(userRows[0].data), { text: 'User: 新会话写在哪一代', time: { created: 1000 } });

  assert.equal(store.completeOpenCodeChatTurn({
    hostHome,
    sessionId: turn.sessionId,
    userMessageId: turn.userMessageId,
    projectPath: '/tmp/demo',
    content: '写在新代里。',
    model: 'opencode-go/glm-5.2',
    usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 2, cached_tokens: 3, cost: 0.01 },
    finishReason: 'stop',
    startedMs: 1000,
    nowMs: 2000
  }), true);

  const rows = db.prepare('SELECT * FROM session_message WHERE session_id = ? ORDER BY seq').all(turn.sessionId);
  assert.deepEqual(rows.map((row) => `${row.type}:${row.seq}`), ['user:0', 'assistant:1']);
  const assistant = JSON.parse(rows[1].data);
  assert.equal(assistant.agent, 'build');
  assert.deepEqual(assistant.model, { id: 'glm-5.2', providerID: 'opencode-go', variant: 'default' });
  assert.deepEqual(assistant.content, [{ type: 'text', text: '写在新代里。' }]);
  assert.equal(assistant.finish, 'stop');
  assert.deepEqual(assistant.tokens, { input: 10, output: 5, reasoning: 2, cache: { write: 0, read: 3 } });
  assert.equal(assistant.cost, 0.01);
  assert.deepEqual(assistant.time, { created: 1000, completed: 2000 });

  const updated = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(turn.sessionId);
  assert.equal(updated.time_updated, 2000);
  assert.equal(updated.agent, 'build');
  assert.equal(updated.tokens_input, 10);
  assert.equal(updated.tokens_output, 5);
  assert.equal(updated.tokens_cache_read, 3);
  assert.equal(updated.cost, 0.01);
  assert.deepEqual(JSON.parse(updated.model), { id: 'glm-5.2', providerID: 'opencode-go', variant: 'default' });

  // 写侧产物必须能被我们的读取器读回（两端消费同一张布局表）。
  const { readSessionMessages } = loadSessionReaderForHome(t, hostHome);
  const messages = readSessionMessages('opencode', { sessionId: turn.sessionId });
  assert.deepEqual(messages.map((message) => `${message.role}:${message.content}`), [
    'user:新会话写在哪一代',
    'assistant:写在新代里。'
  ]);
  db.close();
});

test('续写：两代都有的会话写新代（seq 续号）；仅旧代存在的会话保持旧代（不跨代、无 FK 风险）', (t) => {
  const hostHome = makeHome('aih-oc-write-continue-', t);
  store.ensureOpenCodeSessionTestSchema(hostHome);
  const db = openDb(hostHome);
  const now = 100000;

  // 迁移产物：会话与消息在两代都有（旧代是冻结副本）。
  db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model)
    VALUES ('ses_both', 'proj', NULL, 'both', '/tmp/demo', '两代会话', 'aih-webui', ?, ?, NULL)`).run(now, now);
  db.prepare(`INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model)
    VALUES ('ses_both', 'proj', NULL, 'both', '/tmp/demo', '两代会话', 'aih-webui', ?, ?, NULL)`).run(now, now);
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES ('mleg', 'ses_both', ?, ?, '{"role":"user"}')`).run(now, now);
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('pleg', 'mleg', 'ses_both', ?, ?, '{"type":"text","text":"迁移前提问"}')`).run(now, now);
  db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq)
    VALUES ('m0', 'ses_both', 'user', ?, ?, '{"text":"User: 迁移前提问","time":{"created":100000}}', 0)`).run(now, now);
  db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq)
    VALUES ('m1', 'ses_both', 'assistant', ?, ?, '{"content":[{"type":"text","text":"迁移前回复"}]}', 1)`).run(now, now);

  // 仅旧代存在（旧版 opencode 时代的遗留库写入的 WebUI 会话）。
  db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model)
    VALUES ('ses_legacy_only', 'proj', NULL, 'legacy', '/tmp/demo', '旧代独有', 'aih-webui', ?, ?, NULL)`).run(now, now);

  // 1) 续写两代会话 → 新代；seq 从 migrated max+1 继续。
  const turnBoth = store.beginOpenCodeChatTurn({
    hostHome, sessionId: 'ses_both', projectPath: '/tmp/demo',
    prompt: '续写两代会话', model: 'opencode-go/glm-5.2', nowMs: now + 1000
  });
  assert.equal(turnBoth.created, false);
  assert.equal(store.completeOpenCodeChatTurn({
    hostHome, sessionId: 'ses_both', content: '新代回复', model: 'opencode-go/glm-5.2',
    startedMs: now + 1000, nowMs: now + 2000
  }), true);
  const bothRows = db.prepare('SELECT type, seq FROM session_message WHERE session_id = ? ORDER BY seq').all('ses_both');
  assert.deepEqual(bothRows.map((row) => `${row.type}:${row.seq}`), ['user:0', 'assistant:1', 'user:2', 'assistant:3']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get('ses_both').n, 1, '旧消息表保持冻结（不新增）');

  // 2) 续写仅旧代会话 → 旧代 message/part；绝不写 session_message（否则真机 FK 直接失败）。
  const turnLegacy = store.beginOpenCodeChatTurn({
    hostHome, sessionId: 'ses_legacy_only', projectPath: '/tmp/demo',
    prompt: '续写旧代会话', model: 'opencode-go/glm-5.2', nowMs: now + 3000
  });
  assert.equal(turnLegacy.created, false);
  assert.equal(store.completeOpenCodeChatTurn({
    hostHome, sessionId: 'ses_legacy_only', content: '旧代回复', model: 'opencode-go/glm-5.2',
    startedMs: now + 3000, nowMs: now + 4000
  }), true);
  const legacyParts = db.prepare(`
    SELECT part.data AS part_data FROM message
    JOIN part ON part.message_id = message.id
    WHERE message.session_id = ? ORDER BY message.time_created
  `).all('ses_legacy_only');
  assert.deepEqual(legacyParts.map((row) => JSON.parse(row.part_data).text), ['User: 续写旧代会话', '旧代回复']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?').get('ses_legacy_only').n, 0, '旧代会话不写新代表');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_v2 WHERE id = ?').get('ses_legacy_only').n, 0, '不为旧代会话补建新代行');

  // 3) 传入不存在的 sessionId → 新建会话落活跃布局（新代）。
  const turnMissing = store.beginOpenCodeChatTurn({
    hostHome, sessionId: 'ses_missing', projectPath: '/tmp/demo',
    prompt: '会话不存在时新建', model: 'opencode-go/glm-5.2', nowMs: now + 5000
  });
  assert.equal(turnMissing.created, true);
  assert.ok(db.prepare('SELECT id FROM session_v2 WHERE id = ?').get(turnMissing.sessionId), '兜底新建落新代');
  db.close();
});

test('纯新代库（旧代表不存在）可直接写入；纯旧代库走旧路径', (t) => {
  // 纯新代：模拟 fresh 2.x 安装（会话表/消息表只有新代）。
  const v2Home = makeHome('aih-oc-write-pure-v2-', t);
  store.ensureOpenCodeSessionTestSchema(v2Home);
  {
    const db = openDb(v2Home);
    db.exec('DROP TABLE part; DROP TABLE message; DROP TABLE session;');
    db.close();
  }
  const v2Turn = store.beginOpenCodeChatTurn({
    hostHome: v2Home, projectPath: '/tmp/demo', prompt: '纯新代库写入', model: 'opencode-go/glm-5.2', nowMs: 1000
  });
  assert.equal(v2Turn.created, true);
  assert.equal(store.completeOpenCodeChatTurn({
    hostHome: v2Home, sessionId: v2Turn.sessionId, content: '纯新代回复', model: 'opencode-go/glm-5.2',
    startedMs: 1000, nowMs: 2000
  }), true);
  {
    const db = openDb(v2Home);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_v2 WHERE id = ?').get(v2Turn.sessionId).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?').get(v2Turn.sessionId).n, 2);
    db.close();
  }

  // 纯旧代：未升级的旧库（无新代表）——行为与迁移前一致。
  const legacyHome = makeHome('aih-oc-write-pure-legacy-', t);
  store.ensureOpenCodeSessionTestSchema(legacyHome);
  {
    const db = openDb(legacyHome);
    db.exec('DROP TABLE session_message; DROP TABLE session_v2;');
    db.close();
  }
  const legacyTurn = store.beginOpenCodeChatTurn({
    hostHome: legacyHome, projectPath: '/tmp/demo', prompt: '纯旧代库写入', model: 'opencode-go/glm-5.2', nowMs: 1000
  });
  assert.equal(legacyTurn.created, true);
  assert.equal(store.completeOpenCodeChatTurn({
    hostHome: legacyHome, sessionId: legacyTurn.sessionId, content: '纯旧代回复', model: 'opencode-go/glm-5.2',
    startedMs: 1000, nowMs: 2000
  }), true);
  {
    const db = openDb(legacyHome);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').get(legacyTurn.sessionId).n, 1);
    const texts = db.prepare(`
      SELECT part.data AS part_data FROM message
      JOIN part ON part.message_id = message.id
      WHERE message.session_id = ? ORDER BY message.time_created
    `).all(legacyTurn.sessionId).map((row) => JSON.parse(row.part_data).text);
    assert.deepEqual(texts, ['User: 纯旧代库写入', '纯旧代回复']);
    db.close();
  }
});

test('写入门禁：两代都不可写时报告「想用却没齐」的那一代缺的表', (t) => {
  const bare = makeHome('aih-oc-write-gate-bare-', t);
  store.ensureOpenCodeSessionTestSchema(bare);
  {
    const db = openDb(bare);
    db.exec('DROP TABLE session_message; DROP TABLE session_v2; DROP TABLE part; DROP TABLE message; DROP TABLE session; DROP TABLE project;');
    db.close();
  }
  assert.throws(
    () => store.beginOpenCodeChatTurn({ hostHome: bare, projectPath: '/tmp/demo', prompt: 'x', model: 'm' }),
    (error) => error.code === 'opencode_db_missing_table' && error.tableName === 'project'
  );

  const projectOnly = makeHome('aih-oc-write-gate-project-', t);
  store.ensureOpenCodeSessionTestSchema(projectOnly);
  {
    const db = openDb(projectOnly);
    db.exec('DROP TABLE session_message; DROP TABLE session_v2; DROP TABLE part; DROP TABLE message; DROP TABLE session;');
    db.close();
  }
  assert.throws(
    () => store.beginOpenCodeChatTurn({ hostHome: projectOnly, projectPath: '/tmp/demo', prompt: 'x', model: 'm' }),
    (error) => error.code === 'opencode_db_missing_table' && error.tableName === 'session_v2',
    '两代都没有时报告新代（默认写目标的）会话表'
  );

  const legacyMissingPart = makeHome('aih-oc-write-gate-part-', t);
  store.ensureOpenCodeSessionTestSchema(legacyMissingPart);
  {
    const db = openDb(legacyMissingPart);
    db.exec('DROP TABLE session_message; DROP TABLE session_v2; DROP TABLE part;');
    db.close();
  }
  assert.throws(
    () => store.beginOpenCodeChatTurn({ hostHome: legacyMissingPart, projectPath: '/tmp/demo', prompt: 'x', model: 'm' }),
    (error) => error.code === 'opencode_db_missing_table' && error.tableName === 'part',
    '旧代会话/消息在、part 缺 → 报出旧代缺的表'
  );
});
