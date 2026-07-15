const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_error) {}

function createCodexFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previousRealHome = process.env.REAL_HOME;
  const sessionReaderPath = require.resolve('../lib/sessions/session-reader');
  process.env.REAL_HOME = root;
  delete require.cache[sessionReaderPath];

  t.after(() => {
    if (previousRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = previousRealHome;
    delete require.cache[sessionReaderPath];
    fs.rmSync(root, { recursive: true, force: true });
  });

  const codexDir = path.join(root, '.codex');
  const projectDir = path.join(root, 'project');
  fs.ensureDirSync(codexDir);
  fs.ensureDirSync(projectDir);

  return {
    codexDir,
    projectDir,
    sessionReader: require(sessionReaderPath)
  };
}

function writeCodexRollout(codexDir, sessionId, cwd, payload = {}) {
  const sessionDir = path.join(codexDir, 'sessions', '2026', '07', '13');
  const sessionFile = path.join(sessionDir, `rollout-2026-07-13T12-00-00-${sessionId}.jsonl`);
  fs.ensureDirSync(sessionDir);
  fs.writeFileSync(sessionFile, JSON.stringify({
    timestamp: '2026-07-13T12:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd, ...payload }
  }) + '\n', 'utf8');
  return sessionFile;
}

function writeCodexRecords(codexDir, sessionId, records) {
  const sessionDir = path.join(codexDir, 'sessions', '2026', '07', '13');
  const sessionFile = path.join(sessionDir, `rollout-2026-07-13T12-00-00-${sessionId}.jsonl`);
  fs.ensureDirSync(sessionDir);
  fs.writeFileSync(
    sessionFile,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8'
  );
  return sessionFile;
}

function findCodexSessionIdsInProjects(projects, projectDir) {
  const project = projects
    .find((item) => item.provider === 'codex' && item.path === projectDir);
  return project ? project.sessions.map((session) => session.id).sort() : [];
}

function findCodexSessionIds(sessionReader, projectDir) {
  return findCodexSessionIdsInProjects(sessionReader.readAllProjectsFromHost(), projectDir);
}

function findIncrementalCodexSessionIds(sessionReader, projectDir) {
  const projects = sessionReader.readProjectsFromHostByProviders(['codex'], {
    projectHints: { codexProjectPaths: [projectDir] }
  });
  return findCodexSessionIdsInProjects(projects, projectDir);
}

test('Codex 顶层列表隐藏数据库标记的 subagent，并阻止 rollout 回退重新加入', (t) => {
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const { codexDir, projectDir, sessionReader } = createCodexFixture(
    t,
    'aih-session-reader-codex-subagent-db-'
  );
  const rootId = '10000000-0000-4000-8000-000000000001';
  const sameTitleUserId = '10000000-0000-4000-8000-000000000002';
  const threadSourceChildId = '10000000-0000-4000-8000-000000000003';
  const sourceChildId = '10000000-0000-4000-8000-000000000004';
  const parentColumnChildId = '10000000-0000-4000-8000-000000000005';
  const spawnEdgeChildId = '10000000-0000-4000-8000-000000000006';
  const allIds = [
    rootId,
    sameTitleUserId,
    threadSourceChildId,
    sourceChildId,
    parentColumnChildId,
    spawnEdgeChildId
  ];
  const rolloutPaths = new Map(
    allIds.map((sessionId) => [
      sessionId,
      writeCodexRollout(codexDir, sessionId, projectDir)
    ])
  );

  fs.writeFileSync(
    path.join(codexDir, 'session_index.jsonl'),
    allIds.map((sessionId, index) => JSON.stringify({
      id: sessionId,
      thread_name: '相同 Fabric 会话标题',
      updated_at: `2026-07-13T12:00:0${index}.000Z`
    })).join('\n') + '\n',
    'utf8'
  );

  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        thread_source TEXT,
        parent_thread_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    const insertThread = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, cwd, title, source, thread_source,
        parent_thread_id, archived, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    const insert = (id, source, threadSource, parentThreadId, updatedAt) => insertThread.run(
      id,
      rolloutPaths.get(id),
      projectDir,
      '相同 Fabric 会话标题',
      source,
      threadSource,
      parentThreadId,
      updatedAt
    );

    insert(rootId, 'cli', 'user', null, 1);
    insert(sameTitleUserId, 'cli', 'user', null, 2);
    insert(threadSourceChildId, 'cli', 'subagent', null, 3);
    insert(sourceChildId, JSON.stringify({ subagent: { thread_spawn: {} } }), null, null, 4);
    insert(parentColumnChildId, 'cli', null, rootId, 5);
    db.prepare(`
      INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
      VALUES (?, ?, 'completed')
    `).run(rootId, spawnEdgeChildId);
  } finally {
    db.close();
  }

  assert.deepEqual(
    findCodexSessionIds(sessionReader, projectDir),
    [rootId, sameTitleUserId].sort()
  );
  assert.deepEqual(
    findIncrementalCodexSessionIds(sessionReader, projectDir),
    [rootId, sameTitleUserId].sort()
  );
});

test('Codex 顶层列表隐藏仅由长 rollout session_meta 标记的 subagent', (t) => {
  const { codexDir, projectDir, sessionReader } = createCodexFixture(
    t,
    'aih-session-reader-codex-subagent-rollout-'
  );
  const rootId = '20000000-0000-4000-8000-000000000001';
  const childId = '20000000-0000-4000-8000-000000000002';

  writeCodexRollout(codexDir, rootId, projectDir, { thread_source: 'user' });
  writeCodexRollout(codexDir, childId, projectDir, {
    metadata_padding: 'x'.repeat(4096),
    source: {
      subagent: {
        thread_spawn: { parent_thread_id: rootId }
      }
    },
    parent_thread_id: rootId,
    thread_source: 'subagent'
  });
  fs.writeFileSync(
    path.join(codexDir, 'session_index.jsonl'),
    [rootId, childId].map((sessionId) => JSON.stringify({
      id: sessionId,
      thread_name: '相同 Fabric 会话标题',
      updated_at: '2026-07-13T12:00:00.000Z'
    })).join('\n') + '\n',
    'utf8'
  );

  assert.deepEqual(findCodexSessionIds(sessionReader, projectDir), [rootId]);
  assert.deepEqual(findIncrementalCodexSessionIds(sessionReader, projectDir), [rootId]);
});

test('Codex 顶层列表兼容缺少 subagent 分类字段的旧版 state schema', (t) => {
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const { codexDir, projectDir, sessionReader } = createCodexFixture(
    t,
    'aih-session-reader-codex-subagent-legacy-schema-'
  );
  const sessionId = '30000000-0000-4000-8000-000000000001';
  const db = new DatabaseSync(path.join(codexDir, 'state_4.sqlite'));
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO threads (id, cwd, title, archived, updated_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(sessionId, projectDir, '旧版 schema 正常会话', 1);
  } finally {
    db.close();
  }

  assert.deepEqual(findCodexSessionIds(sessionReader, projectDir), [sessionId]);
});

test('Codex 父会话只暴露 subagent 引用并保留 child transcript 独立读取', (t) => {
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const { codexDir, projectDir, sessionReader } = createCodexFixture(
    t,
    'aih-session-reader-codex-subagent-reference-'
  );
  const parentId = '40000000-0000-4000-8000-000000000001';
  const childId = '40000000-0000-4000-8000-000000000002';
  const unnamedChildId = '40000000-0000-4000-8000-000000000003';
  const unlinkedChildId = '40000000-0000-4000-8000-000000000004';
  const parentRolloutPath = writeCodexRecords(codexDir, parentId, [
    {
      timestamp: '2026-07-13T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: parentId, cwd: projectDir, thread_source: 'user' }
    },
    {
      timestamp: '2026-07-13T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call-spawn-review',
        arguments: JSON.stringify({
          task_name: 'review_code',
          fork_turns: 'all',
          message: 'encrypted-child-prompt'
        })
      }
    },
    {
      timestamp: '2026-07-13T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-spawn-review',
        output: JSON.stringify({ task_name: '/root/review_code' })
      }
    },
    {
      timestamp: '2026-07-13T12:00:02.100Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call-spawn-unnamed-review',
        arguments: JSON.stringify({
          task_name: 'unnamed_review',
          fork_turns: 'all',
          message: 'encrypted-unnamed-child-prompt'
        })
      }
    },
    {
      timestamp: '2026-07-13T12:00:02.200Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-spawn-unnamed-review',
        output: JSON.stringify({ task_name: '/root/unnamed_review' })
      }
    },
    {
      timestamp: '2026-07-13T12:00:02.300Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call-spawn-capacity-review',
        arguments: JSON.stringify({
          task_name: 'capacity_review',
          fork_turns: 'all',
          message: 'encrypted-failed-child-prompt'
        })
      }
    },
    {
      timestamp: '2026-07-13T12:00:02.400Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-spawn-capacity-review',
        output: 'collab spawn failed: agent thread limit reached'
      }
    }
  ]);
  const childRolloutPath = writeCodexRecords(codexDir, childId, [
    {
      timestamp: '2026-07-13T12:00:03.000Z',
      type: 'session_meta',
      payload: {
        id: childId,
        cwd: projectDir,
        thread_source: 'subagent',
        parent_thread_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              agent_path: '/root/review_code',
              agent_nickname: 'Curie'
            }
          }
        }
      }
    },
    {
      timestamp: '2026-07-13T12:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '检查实现' }
    },
    {
      timestamp: '2026-07-13T12:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'CHILD_TRANSCRIPT_COMPLETE' }]
      }
    }
  ]);
  const unnamedChildRolloutPath = writeCodexRecords(codexDir, unnamedChildId, [
    {
      timestamp: '2026-07-13T12:00:02.250Z',
      type: 'session_meta',
      payload: {
        id: unnamedChildId,
        cwd: projectDir,
        thread_source: 'subagent',
        parent_thread_id: parentId
      }
    },
    {
      timestamp: '2026-07-13T12:00:03.500Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'UNNAMED_CHILD_TRANSCRIPT_COMPLETE' }]
      }
    }
  ]);
  const unlinkedChildRolloutPath = writeCodexRecords(codexDir, unlinkedChildId, [
    {
      timestamp: '2026-07-13T12:00:06.000Z',
      type: 'session_meta',
      payload: {
        id: unlinkedChildId,
        cwd: projectDir,
        thread_source: 'subagent',
        parent_thread_id: parentId
      }
    },
    {
      timestamp: '2026-07-13T12:00:07.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'UNLINKED_CHILD_TRANSCRIPT_COMPLETE' }]
      }
    }
  ]);

  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        thread_source TEXT,
        agent_path TEXT,
        agent_nickname TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    const insertThread = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, cwd, title, source, thread_source,
        agent_path, agent_nickname, archived, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    insertThread.run(
      parentId,
      parentRolloutPath,
      projectDir,
      '父会话',
      'cli',
      'user',
      null,
      null,
      1,
      2
    );
    insertThread.run(
      childId,
      childRolloutPath,
      projectDir,
      '父会话',
      JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parentId } } }),
      'subagent',
      '/root/review_code',
      'Curie',
      3,
      5
    );
    insertThread.run(
      unnamedChildId,
      unnamedChildRolloutPath,
      projectDir,
      '父会话',
      JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parentId } } }),
      'subagent',
      null,
      'Noether',
      Date.parse('2026-07-13T12:00:02.250Z'),
      Date.parse('2026-07-13T12:00:03.500Z')
    );
    insertThread.run(
      unlinkedChildId,
      unlinkedChildRolloutPath,
      projectDir,
      '父会话',
      JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parentId } } }),
      'subagent',
      null,
      'Turing',
      Date.parse('2026-07-13T12:00:06.000Z'),
      Date.parse('2026-07-13T12:00:07.000Z')
    );
    const insertEdge = db.prepare(`
      INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
      VALUES (?, ?, 'open')
    `);
    insertEdge.run(parentId, childId);
    insertEdge.run(parentId, unnamedChildId);
    insertEdge.run(parentId, unlinkedChildId);
  } finally {
    db.close();
  }

  const parentMessages = sessionReader.readSessionMessages('codex', { sessionId: parentId });
  const parentContent = parentMessages.map((message) => message.content).join('\n');
  assert.match(parentContent, /:::tool\{name="spawn_agent"\}/);
  assert.match(parentContent, new RegExp(childId));
  assert.match(parentContent, /"task_name":"review_code"/);
  assert.match(parentContent, /"agent_nickname":"Curie"/);
  assert.match(parentContent, new RegExp(unnamedChildId));
  assert.match(parentContent, /"task_name":"unnamed_review"/);
  assert.match(parentContent, /"agent_nickname":"Noether"/);
  assert.match(parentContent, new RegExp(unlinkedChildId));
  assert.match(parentContent, /"agent_nickname":"Turing"/);
  assert.match(parentContent, /"task_name":"capacity_review"/);
  assert.match(parentContent, /collab spawn failed: agent thread limit reached/);
  assert.doesNotMatch(parentContent, /encrypted-failed-child-prompt/);
  assert.doesNotMatch(parentContent, /CHILD_TRANSCRIPT_COMPLETE/);

  const childMessages = sessionReader.readSessionMessages('codex', { sessionId: childId });
  assert.equal(childMessages.at(-1)?.content, 'CHILD_TRANSCRIPT_COMPLETE');
  const unnamedChildMessages = sessionReader.readSessionMessages('codex', { sessionId: unnamedChildId });
  assert.equal(unnamedChildMessages.at(-1)?.content, 'UNNAMED_CHILD_TRANSCRIPT_COMPLETE');
  const unlinkedChildMessages = sessionReader.readSessionMessages('codex', { sessionId: unlinkedChildId });
  assert.equal(unlinkedChildMessages.at(-1)?.content, 'UNLINKED_CHILD_TRANSCRIPT_COMPLETE');
});

test('Codex 会话消息缓存随 state SQLite WAL 中的 subagent descriptor 失效', (t) => {
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const { codexDir, projectDir, sessionReader } = createCodexFixture(
    t,
    'aih-session-reader-codex-subagent-cache-version-'
  );
  const parentId = '50000000-0000-4000-8000-000000000001';
  const childId = '50000000-0000-4000-8000-000000000002';
  const parentRolloutPath = writeCodexRecords(codexDir, parentId, [
    {
      timestamp: '2026-07-14T12:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call-cache-version',
        arguments: JSON.stringify({ task_name: 'review_code' })
      }
    }
  ]);
  const stateDbPath = path.join(codexDir, 'state_5.sqlite');
  const db = new DatabaseSync(stateDbPath);

  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        source TEXT,
        agent_path TEXT,
        agent_nickname TEXT,
        agent_role TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO threads (
        id, source, agent_path, agent_nickname, agent_role, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(childId, 'subagent', '/root/review_code', 'Curie', 'reviewer', 1, 2);
    db.prepare(`
      INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
      VALUES (?, ?, 'open')
    `).run(parentId, childId);

    const transcriptStats = fs.statSync(parentRolloutPath);
    const first = sessionReader.readSessionMessages('codex', { sessionId: parentId });
    assert.match(first.map((message) => message.content).join('\n'), /"agent_nickname":"Curie"/);

    db.prepare(`
      INSERT INTO threads (
        id, source, agent_path, agent_nickname, agent_role, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '50000000-0000-4000-8000-000000000099',
      'user',
      null,
      null,
      null,
      2,
      3
    );
    const unchanged = sessionReader.readSessionMessages('codex', { sessionId: parentId });
    assert.strictEqual(unchanged, first, 'unrelated WAL writes keep the parsed parent session cached');

    db.prepare('UPDATE threads SET agent_nickname = ?, updated_at_ms = ? WHERE id = ?')
      .run('Tesla', 4, childId);
    assert.ok(fs.statSync(`${stateDbPath}-wal`).size > 0, 'descriptor update remains visible in WAL');
    assert.equal(fs.statSync(parentRolloutPath).size, transcriptStats.size);
    assert.equal(fs.statSync(parentRolloutPath).mtimeMs, transcriptStats.mtimeMs);

    const refreshed = sessionReader.readSessionMessages('codex', { sessionId: parentId });
    const refreshedContent = refreshed.map((message) => message.content).join('\n');
    assert.match(refreshedContent, /"agent_nickname":"Tesla"/);
    assert.doesNotMatch(refreshedContent, /"agent_nickname":"Curie"/);
  } finally {
    db.close();
  }
});
