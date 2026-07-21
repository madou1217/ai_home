const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const sessionReader = require('../lib/sessions/session-reader');

test('readSessionMessages reads codex session messages without full file utf8 read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadFileSync = fs.readFileSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '019c9889-13a4-7191-a40d-94c83b91bd72';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '02', '26');
    const sessionFile = path.join(sessionDir, `rollout-2026-02-26T14-00-46-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      JSON.stringify({
        id: sessionId,
        thread_name: '查阅文档需求内容内容无法重复 maybe',
        updated_at: '2026-02-26T14:00:46.000Z'
      }) + '\n'
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-02-26T14:00:46.000Z',
          type: 'session_meta',
          payload: {
            id: sessionId,
            cwd: '/Users/model/projects/edu-en'
          }
        }),
        JSON.stringify({
          timestamp: '2026-02-26T14:00:47.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '查一下这个项目的文档'
          }
        }),
        JSON.stringify({
          timestamp: '2026-02-26T14:00:47.500Z',
          type: 'turn_context',
          payload: {
            turn_id: 'turn-1',
            model: 'gpt-5.6-sol'
          }
        }),
        JSON.stringify({
          timestamp: '2026-02-26T14:00:48.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [
              { type: 'output_text', text: '我先看一下项目结构。' }
            ]
          }
        })
      ].join('\n') + '\n'
    );

    fs.readFileSync = function patchedReadFileSync(targetPath, ...args) {
      if (targetPath === sessionFile && args[0] === 'utf8') {
        const error = new Error('Cannot create a string longer than 0x1fffffe8 characters');
        error.code = 'ERR_STRING_TOO_LONG';
        throw error;
      }
      return originalReadFileSync.call(this, targetPath, ...args);
    };

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((item) => ({ role: item.role, content: item.content, model: item.model })),
      [
        { role: 'user', content: '查一下这个项目的文档', model: 'gpt-5.6-sol' },
        { role: 'assistant', content: '我先看一下项目结构。', model: 'gpt-5.6-sol' }
      ]
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex snapshot cursor excludes an append that starts after the parser fstat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-atomic-snapshot-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadSync = fs.readSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-000000000001';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T22-00-00-${sessionId}.jsonl`);
    const firstRecord = JSON.stringify({
      timestamp: '2026-07-14T22:00:00.000Z',
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'OK' }]
      }
    }) + '\n';
    const secondRecord = JSON.stringify({
      timestamp: '2026-07-14T22:00:01.000Z',
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'OK' }]
      }
    }) + '\n';
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, firstRecord, 'utf8');
    const snapshotSize = fs.statSync(sessionFile).size;
    const sessionInode = fs.statSync(sessionFile).ino;
    let appended = false;

    fs.readSync = function patchedReadSync(fd, ...args) {
      if (!appended && fs.fstatSync(fd).ino === sessionInode) {
        appended = true;
        fs.appendFileSync(sessionFile, secondRecord, 'utf8');
      }
      return originalReadSync.call(this, fd, ...args);
    };

    const snapshot = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });
    fs.readSync = originalReadSync;
    const events = sessionReader.readSessionEvents('codex', { sessionId }, {
      cursor: snapshot.cursor
    });

    assert.equal(snapshot.cursor, snapshotSize);
    assert.deepEqual(snapshot.messages.map((message) => message.content), ['OK']);
    assert.equal(events.cursor, fs.statSync(sessionFile).size);
    assert.deepEqual(events.events.map((event) => event.text), ['OK']);
    assert.equal(`${snapshot.messages[0].content}\n${events.events[0].text}`.match(/OK/g).length, 2);
  } finally {
    fs.readSync = originalReadSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex snapshot cursor survives a session message cache hit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-cached-cursor-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-000000000010';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '15');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-15T10-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, JSON.stringify({
      timestamp: '2026-07-15T10:00:00.000Z',
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'cached cursor' }]
      }
    }) + '\n', 'utf8');
    const expectedCursor = fs.statSync(sessionFile).size;

    const first = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });
    const cached = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });

    assert.equal(first.cursor, expectedCursor);
    assert.equal(cached.cursor, expectedCursor);
    assert.deepEqual(cached.messages.map((message) => message.content), ['cached cursor']);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages does not cache an empty result caused by a read failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-failed-empty-cache-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-000000000002';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T22-01-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, JSON.stringify({
      timestamp: '2026-07-14T22:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'recovered message' }
    }) + '\n', 'utf8');

    let failNextOpen = true;
    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (targetPath === sessionFile && failNextOpen) {
        failNextOpen = false;
        throw new Error('simulated transcript read failure');
      }
      return originalOpenSync.call(this, targetPath, ...args);
    };

    const failed = sessionReader.readSessionMessages('codex', { sessionId });
    const recovered = sessionReader.readSessionMessages('codex', { sessionId });

    assert.deepEqual(failed, []);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].content, 'recovered message');
  } finally {
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessagesSnapshot reports persistent Codex transcript I/O failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-strict-codex-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalStatSync = fs.statSync;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-000000000003';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T22-02-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, JSON.stringify({
      timestamp: '2026-07-14T22:02:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'must not become empty history' }
    }) + '\n', 'utf8');

    fs.statSync = function patchedStatSync(targetPath, ...args) {
      if (targetPath === sessionFile) throw new Error('simulated persistent stat failure');
      return originalStatSync.call(this, targetPath, ...args);
    };
    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (targetPath === sessionFile) throw new Error('simulated persistent open failure');
      return originalOpenSync.call(this, targetPath, ...args);
    };

    assert.throws(
      () => sessionReader.readSessionMessagesSnapshot('codex', { sessionId }),
      /simulated persistent (?:stat|open) failure/u
    );
  } finally {
    fs.statSync = originalStatSync;
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessagesSnapshot reports Codex session directory resolution failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-strict-codex-dir-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReaddirSync = fs.readdirSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-000000000004';
    const sessionsDir = path.join(root, '.codex', 'sessions');
    const sessionDir = path.join(sessionsDir, '2026', '07', '14');
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, `rollout-${sessionId}.jsonl`), JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'must not become empty history' }
    }) + '\n', 'utf8');

    fs.readdirSync = function patchedReaddirSync(targetPath, ...args) {
      if (targetPath === sessionsDir) {
        const error = new Error('simulated Codex sessions directory EACCES');
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddirSync.call(this, targetPath, ...args);
    };

    assert.deepEqual(
      sessionReader.readSessionMessages('codex', { sessionId }),
      [],
      'ordinary preview reads remain best-effort'
    );
    assert.throws(
      () => sessionReader.readSessionMessagesSnapshot('codex', { sessionId }),
      /simulated Codex sessions directory EACCES/u
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessagesSnapshot reports Codex state database read failures without a file fallback', (t) => {
  try {
    require('node:sqlite');
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-strict-codex-state-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    fs.ensureDirSync(codexDir);
    fs.writeFileSync(path.join(codexDir, 'state_5.sqlite'), 'not a sqlite database', 'utf8');

    assert.throws(
      () => sessionReader.readSessionMessagesSnapshot('codex', {
        sessionId: 'cccccccc-cccc-4ccc-8ccc-000000000005'
      }),
      /not a database/u
    );
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessagesSnapshot keeps a genuinely missing Codex transcript empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-missing-codex-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const snapshot = sessionReader.readSessionMessagesSnapshot('codex', {
      sessionId: 'cccccccc-cccc-4ccc-8ccc-000000000006'
    });

    assert.deepEqual(snapshot, { messages: [], cursor: 0 });
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessagesSnapshot reports persistent Claude transcript I/O failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-strict-claude-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadFileSync = fs.readFileSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'claude-strict-read-failure';
    const projectDirName = '-Users-model-projects-feature-ai-home';
    const sessionFile = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);
    fs.ensureDirSync(path.dirname(sessionFile));
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: 'user',
      message: { content: 'must not become empty history' }
    }) + '\n', 'utf8');

    fs.readFileSync = function patchedReadFileSync(targetPath, ...args) {
      if (targetPath === sessionFile) throw new Error('simulated persistent Claude read failure');
      return originalReadFileSync.call(this, targetPath, ...args);
    };

    assert.throws(
      () => sessionReader.readSessionMessagesSnapshot('claude', { sessionId, projectDirName }),
      /simulated persistent Claude read failure/u
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages reuses a dependency-versioned parse cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-cache-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T20-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    const records = [
      {
        timestamp: '2026-07-14T20:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'first' }
      },
      {
        timestamp: '2026-07-14T20:00:01.000Z',
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] }
      }
    ];
    fs.writeFileSync(sessionFile, records.map(JSON.stringify).join('\n') + '\n', 'utf8');

    let transcriptOpenCount = 0;
    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (targetPath === sessionFile) transcriptOpenCount += 1;
      return originalOpenSync.call(this, targetPath, ...args);
    };

    const first = sessionReader.readSessionMessages('codex', { sessionId });
    const second = sessionReader.readSessionMessages('codex', { sessionId });
    assert.deepEqual(second, first);
    assert.equal(transcriptOpenCount, 1);

    fs.appendFileSync(sessionFile, JSON.stringify({
      timestamp: '2026-07-14T20:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'after-cache' }
    }) + '\n', 'utf8');

    const refreshed = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(transcriptOpenCount, 2);
    assert.equal(refreshed.at(-1).content, 'after-cache');
  } finally {
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps a bounded least-recently-used parse cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-lru-cache-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionIds = Array.from({ length: 5 }, (_item, index) => (
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`
    ));
    const sessionFiles = new Map();
    fs.ensureDirSync(sessionDir);

    sessionIds.forEach((sessionId, index) => {
      const sessionFile = path.join(sessionDir, `rollout-2026-07-14T21-00-0${index}-${sessionId}.jsonl`);
      sessionFiles.set(sessionId, sessionFile);
      fs.writeFileSync(sessionFile, JSON.stringify({
        timestamp: `2026-07-14T21:00:0${index}.000Z`,
        type: 'event_msg',
        payload: { type: 'user_message', message: `message-${index}` }
      }) + '\n', 'utf8');
    });

    const trackedSessionFiles = new Set(sessionFiles.values());
    const openCounts = new Map();
    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (trackedSessionFiles.has(targetPath)) {
        openCounts.set(targetPath, (openCounts.get(targetPath) || 0) + 1);
      }
      return originalOpenSync.call(this, targetPath, ...args);
    };

    sessionIds.slice(0, 4).forEach((sessionId) => {
      sessionReader.readSessionMessages('codex', { sessionId });
    });
    sessionReader.readSessionMessages('codex', { sessionId: sessionIds[0] });
    sessionReader.readSessionMessages('codex', { sessionId: sessionIds[4] });
    sessionReader.readSessionMessages('codex', { sessionId: sessionIds[0] });
    sessionReader.readSessionMessages('codex', { sessionId: sessionIds[1] });

    assert.equal(openCounts.get(sessionFiles.get(sessionIds[0])), 1, 'recent entry remains cached');
    assert.equal(openCounts.get(sessionFiles.get(sessionIds[1])), 2, 'least-recent entry is evicted');
  } finally {
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps codex goal XML user context blocks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-synthetic-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '06', '08');
    const sessionFile = path.join(sessionDir, `rollout-2026-06-08T08-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-06-08T08:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<environment_context>\n<current_date>2026-06-08</current_date>\n</environment_context>'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T08:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>'
              }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T08:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<codex_internal_context source="goal">\n<objective>继续内部目标</objective>\n</codex_internal_context>'
              }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T08:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<goal_context>\n<objective>旧版目标上下文</objective>\n</goal_context>'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T08:00:04.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '继续修复 resume'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T08:00:05.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: '我继续处理。' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.deepEqual(
      messages.map((item) => ({ role: item.role, content: item.content })),
      [
        {
          role: 'user',
          content: '<codex_internal_context source="goal">\n<objective>继续内部目标</objective>\n</codex_internal_context>'
        },
        {
          role: 'user',
          content: '<goal_context>\n<objective>旧版目标上下文</objective>\n</goal_context>'
        },
        { role: 'user', content: '继续修复 resume' },
        { role: 'assistant', content: '我继续处理。' }
      ]
    );
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost keeps codex session projects even when config.toml registered project list is incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-projects-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const keptProject = path.join(root, 'kept-project');
    const removedProject = path.join(root, 'removed-project');
    fs.ensureDirSync(keptProject);
    fs.ensureDirSync(removedProject);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '12'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      `[projects."${keptProject}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );

    const keptSessionId = '11111111-1111-4111-8111-111111111111';
    const removedSessionId = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id: keptSessionId, thread_name: '保留项目会话', updated_at: '2026-04-12T10:00:00.000Z' }),
        JSON.stringify({ id: removedSessionId, thread_name: '被移除项目会话', updated_at: '2026-04-12T11:00:00.000Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-12T10-00-00-${keptSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-12T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: keptSessionId, cwd: keptProject }
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-12T11-00-00-${removedSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-12T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: removedSessionId, cwd: removedProject }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    assert.equal(projects.some((project) => project.path === keptProject), true);
    assert.equal(projects.some((project) => project.path === removedProject), true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readCodexSessionProjectPath normalizes Windows cwd for host lookup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-win-cwd-'));
  try {
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const sessionFile = path.join(root, `rollout-2026-04-12T12-00-00-${sessionId}.jsonl`);
    const projectPath = 'C:\\Users\\madou\\projects\\feature\\ai_home';
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectPath }
      }) + '\n',
      'utf8'
    );

    assert.equal(
      sessionReader.readCodexSessionProjectPath(sessionFile),
      '/mnt/c/Users/madou/projects/feature/ai_home'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost reads codex projects from state sqlite threads', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-state-db-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    const projectDir = path.join(root, 'state-db-project');
    fs.ensureDirSync(codexDir);
    fs.ensureDirSync(projectDir);

    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          sandbox_policy TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER,
          updated_at_ms INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, archived, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '33333333-3333-4333-8333-333333333333',
        '/tmp/rollout.jsonl',
        1770000000,
        1770000001,
        'cli',
        'aih_10',
        projectDir,
        '新版 state db 会话',
        'workspace-write',
        'on-request',
        0,
        1770000000000,
        1770000001000
      );
    } finally {
      db.close();
    }

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'codex' && item.path === projectDir);
    assert.ok(project);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].title, '新版 state db 会话');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost matches Codex resume by excluding non-interactive exec threads', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-visible-source-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    const projectDir = path.join(root, 'visible-source-project');
    const sessionDir = path.join(codexDir, 'sessions', '2026', '07', '15');
    fs.ensureDirSync(sessionDir);
    fs.ensureDirSync(projectDir);
    const interactiveId = '31313131-3131-4313-8313-313131313131';
    const execId = '32323232-3232-4323-8323-323232323232';
    const execRollout = path.join(sessionDir, `rollout-2026-07-15T10-00-00-${execId}.jsonl`);
    fs.writeFileSync(execRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: execId, cwd: projectDir, source: 'exec' }
    })}\n${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: '不应出现在默认会话列表' }
    })}\n`, 'utf8');

    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          sandbox_policy TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER,
          updated_at_ms INTEGER
        );
      `);
      const insert = db.prepare(`
        INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, archived, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        interactiveId, '/tmp/interactive.jsonl', 1770000000, 1770000002, 'cli', 'aih',
        projectDir, '交互会话', 'workspace-write', 'on-request', 0, 1770000000000, 1770000002000
      );
      insert.run(
        execId, execRollout, 1770000000, 1770000001, 'exec', 'aih',
        projectDir, '批处理会话', 'workspace-write', 'on-request', 0, 1770000000000, 1770000001000
      );
    } finally {
      db.close();
    }

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'codex' && item.path === projectDir);
    assert.ok(project);
    assert.deepEqual(project.sessions.map((session) => session.id), [interactiveId]);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost normalizes Windows codex cwd from state sqlite', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-win-cwd-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    fs.ensureDirSync(codexDir);

    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO threads (id, rollout_path, cwd, title, archived, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        '66666666-6666-4666-8666-666666666666',
        '',
        '\\\\?\\C:\\Users\\madou\\projects\\feature\\ai_home',
        'Windows state cwd 会话',
        0,
        1770000001000
      );
    } finally {
      db.close();
    }

    const projects = sessionReader.readAllProjectsFromHost();
    const expectedPath = process.platform === 'win32'
      ? 'C:\\Users\\madou\\projects\\feature\\ai_home'
      : '/mnt/c/Users/madou/projects/feature/ai_home';
    const project = projects.find((item) => (
      item.provider === 'codex'
      && item.path === expectedPath
    ));
    assert.ok(project);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].title, 'Windows state cwd 会话');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost falls back to first_user_message for blank codex state titles', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-state-title-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    const projectDir = path.join(root, 'state-title-fallback-project');
    fs.ensureDirSync(codexDir);
    fs.ensureDirSync(projectDir);

    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          first_user_message TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.prepare(`
        INSERT INTO threads (
          id, rollout_path, created_at, updated_at, cwd, title, first_user_message, archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '44444444-4444-4444-8444-444444444444',
        '/tmp/rollout.jsonl',
        1770000000,
        1770000001,
        projectDir,
        '',
        '从 first_user_message 恢复标题',
        0
      );
    } finally {
      db.close();
    }

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'codex' && item.path === projectDir);
    assert.ok(project);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].title, '从 first_user_message 恢复标题');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost falls back to rollout title for fully blank codex state titles', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-state-rollout-title-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    const projectDir = path.join(root, 'state-rollout-title-project');
    const sessionDir = path.join(codexDir, 'sessions', '2026', '05', '15');
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const rolloutPath = path.join(sessionDir, `rollout-2026-05-15T17-10-34-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.ensureDirSync(projectDir);
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-15T17:10:34.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectDir }
      }),
      JSON.stringify({
        timestamp: '2026-05-15T17:10:35.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '从 rollout 恢复标题' }
      })
    ].join('\n') + '\n', 'utf8');

    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          first_user_message TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.prepare(`
        INSERT INTO threads (
          id, rollout_path, created_at, updated_at, cwd, title, first_user_message, archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        rolloutPath,
        1770000000,
        1770000001,
        projectDir,
        '',
        '',
        0
      );
    } finally {
      db.close();
    }

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'codex' && item.path === projectDir);
    assert.ok(project);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].title, '从 rollout 恢复标题');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost filters sessions without ids before returning projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-empty-session-id-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectName = 'empty-session-id-project';
    const chatDir = path.join(root, '.gemini', 'tmp', projectName, 'chats');
    fs.ensureDirSync(chatDir);
    fs.writeFileSync(
      path.join(chatDir, '.json'),
      JSON.stringify({
        summary: '空 id 会话不应出现在列表',
        lastUpdated: '2026-06-08T11:00:00.000Z',
        messages: [{ type: 'user', content: '空 id 会话不应出现在列表' }]
      }),
      'utf8'
    );

    const projects = sessionReader.readProjectsFromHostByProviders(['gemini'], {
      projectHints: { geminiProjectNames: [projectName] }
    });
    const project = projects.find((item) => item.provider === 'gemini' && item.name === projectName);
    assert.ok(project);
    assert.deepEqual(project.sessions, []);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readProjectsFromHostByProviders surfaces native gemini .jsonl session files (not just .json checkpoints)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-gemini-jsonl-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectName = 'gemini-jsonl-project';
    const chatDir = path.join(root, '.gemini', 'tmp', projectName, 'chats');
    fs.ensureDirSync(chatDir);
    // WebUI native gemini session 落盘为 session-*.jsonl（首行 meta + user/gemini 记录），
    // 旧实现只读 .json → 这种会话在列表里消失。修复后应可见。
    fs.writeFileSync(
      path.join(chatDir, 'session-1739000000000-abcd1234.jsonl'),
      [
        JSON.stringify({ sessionId: 'gem-native-1', projectHash: projectName }),
        JSON.stringify({ type: 'user', content: '帮我看下这个原生会话', timestamp: '2026-06-08T11:00:00.000Z' }),
        JSON.stringify({ type: 'gemini', content: '好的', timestamp: '2026-06-08T11:00:02.000Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    const projects = sessionReader.readProjectsFromHostByProviders(['gemini'], {
      projectHints: { geminiProjectNames: [projectName] }
    });
    const project = projects.find((item) => item.provider === 'gemini' && item.name === projectName);
    assert.ok(project, 'gemini project should be listed');
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].id, 'gem-native-1');
    assert.equal(project.sessions[0].title, '帮我看下这个原生会话');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages resolves codex rollout path from state sqlite without scanning session tree', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-state-path-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReaddirSync = fs.readdirSync;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    const sessionsRoot = path.join(codexDir, 'sessions');
    const projectDir = path.join(root, 'state-path-project');
    const sessionId = '44444444-4444-4444-9444-444444444444';
    const sessionDir = path.join(sessionsRoot, '2026', '04', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-14T10-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.ensureDirSync(projectDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-14T10:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '直接从 state db 定位这条会话'
          }
        })
      ].join('\n') + '\n',
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
          archived INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER,
          updated_at_ms INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO threads (id, rollout_path, cwd, title, archived, updated_at, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        sessionFile,
        projectDir,
        'state db 路径会话',
        0,
        1770000000,
        1770000000000
      );
    } finally {
      db.close();
    }

    fs.readdirSync = function patchedReaddirSync(targetPath, ...args) {
      if (targetPath === sessionsRoot) {
        throw new Error('session tree scan forbidden');
      }
      return originalReaddirSync.call(this, targetPath, ...args);
    };

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '直接从 state db 定位这条会话');
  } finally {
    fs.readdirSync = originalReaddirSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost skips codex rollout metadata scan when state sqlite has the thread', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-skip-jsonl-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const codexDir = path.join(root, '.codex');
    const projectDir = path.join(root, 'state-skip-project');
    const sessionId = '55555555-5555-4555-9555-555555555555';
    const sessionDir = path.join(codexDir, 'sessions', '2026', '04', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-14T11-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.ensureDirSync(projectDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-14T11:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: projectDir
        }
      }) + '\n',
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
          archived INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER,
          updated_at_ms INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO threads (id, rollout_path, cwd, title, archived, updated_at, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        sessionFile,
        projectDir,
        '不应打开 JSONL 回退扫描',
        0,
        1770000001,
        1770000001000
      );
    } finally {
      db.close();
    }

    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (targetPath === sessionFile) {
        throw new Error('rollout metadata scan forbidden');
      }
      return originalOpenSync.call(this, targetPath, ...args);
    };

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'codex' && item.path === projectDir);
    assert.ok(project);
    assert.deepEqual(project.sessions.map((session) => session.id), [sessionId]);
  } finally {
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost ignores codex worktree sessions but keeps unrelated real projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-worktree-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProject = path.join(root, 'real-project');
    const worktreeProject = path.join(root, '.codex', 'worktrees', 'abcd', 'real-project');
    fs.ensureDirSync(realProject);
    fs.ensureDirSync(worktreeProject);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '13'));

    const realSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const worktreeSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const windowsWorktreeSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const windowsWorktreeProject = 'C:\\Users\\madou\\.codex\\worktrees\\abcd\\real-project';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id: realSessionId, thread_name: '真实项目会话', updated_at: '2026-04-13T10:00:00.000Z' }),
        JSON.stringify({ id: worktreeSessionId, thread_name: 'worktree 项目会话', updated_at: '2026-04-13T11:00:00.000Z' }),
        JSON.stringify({ id: windowsWorktreeSessionId, thread_name: 'Windows worktree 项目会话', updated_at: '2026-04-13T12:00:00.000Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '13');
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T10-00-00-${realSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: realSessionId, cwd: realProject }
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T11-00-00-${worktreeSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: worktreeSessionId, cwd: worktreeProject }
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T12-00-00-${windowsWorktreeSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: windowsWorktreeSessionId, cwd: windowsWorktreeProject }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    assert.equal(projects.some((project) => project.path === realProject), true);
    assert.equal(projects.some((project) => project.path === worktreeProject), false);
    assert.equal(projects.some((project) => project.path === windowsWorktreeProject), false);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost falls back to first codex user message when session_index thread_name is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-title-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectPath = path.join(root, 'feature-project');
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '12'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      `[projects."${projectPath}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );

    const sessionId = '33333333-4444-4555-8666-777777777777';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      JSON.stringify({ id: sessionId, updated_at: '2026-04-12T10:00:00.000Z' }) + '\n',
      'utf8'
    );

    const sessionFile = path.join(root, '.codex', 'sessions', '2026', '04', '12', `rollout-2026-04-12T10-00-00-${sessionId}.jsonl`);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: sessionId, cwd: projectPath }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'E2E transcript check: reply with exactly OK.' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.path === projectPath);
    assert.ok(project);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].id, sessionId);
    assert.equal(project.sessions[0].title, 'E2E transcript check: reply with exactly OK.');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex session index resumes from an incomplete final JSONL record', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-index-tail-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectPath = path.join(root, 'feature-project');
    const codexDir = path.join(root, '.codex');
    const sessionId = '33333333-4444-4555-8666-777777777778';
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(codexDir);

    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        title TEXT,
        source TEXT,
        archived INTEGER DEFAULT 0,
        updated_at_ms INTEGER
      )
    `);
    db.prepare(`
      INSERT INTO threads (id, cwd, title, source, archived, updated_at_ms)
      VALUES (?, ?, 'DB FALLBACK', 'cli', 0, 1)
    `).run(sessionId, projectPath);
    db.close();

    const indexRecord = JSON.stringify({
      id: sessionId,
      thread_name: 'INDEX TITLE',
      updated_at: '2026-07-15T00:00:00.000Z'
    });
    const splitAt = indexRecord.length - 8;
    const sessionIndexPath = path.join(codexDir, 'session_index.jsonl');
    fs.writeFileSync(sessionIndexPath, indexRecord.slice(0, splitAt), 'utf8');

    const firstProjects = sessionReader.readProjectsFromHostByProviders(['codex']);
    assert.equal(firstProjects[0].sessions[0].title, 'DB FALLBACK');

    fs.appendFileSync(sessionIndexPath, `${indexRecord.slice(splitAt)}\n`, 'utf8');
    const secondProjects = sessionReader.readProjectsFromHostByProviders(['codex']);
    assert.equal(secondProjects[0].sessions[0].title, 'INDEX TITLE');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost strips embedded codex sessions picker transcript from title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-picker-title-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectPath = path.join(root, 'feature-project');
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '12'));

    const sessionId = '44444444-4444-4555-8666-777777777777';
    fs.writeFileSync(
      path.join(root, '.codex', 'session_index.jsonl'),
      JSON.stringify({
        id: sessionId,
        thread_name: 'aih codex sessions\n[aih] 选择要进入的持久会话（Enter=镜像进入，↑/↓=选择，q/Esc=退出）\n/work\n> ⠿ 在用 GPT #1 scoped commit',
        updated_at: '2026-04-12T10:00:00.000Z'
      }) + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(root, '.codex', 'sessions', '2026', '04', '12', `rollout-2026-04-12T10-00-00-${sessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-12T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectPath }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.path === projectPath);
    assert.ok(project);
    assert.equal(project.sessions[0].title, 'aih codex sessions');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost reuses cached codex metadata when session files are unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-cache-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalOpenSync = fs.openSync;
  process.env.REAL_HOME = root;

  try {
    const projectPath = path.join(root, 'cached-project');
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(path.join(root, '.codex', 'sessions', '2026', '04', '13'));

    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const sessionIndexPath = path.join(root, '.codex', 'session_index.jsonl');
    const sessionFile = path.join(
      root,
      '.codex',
      'sessions',
      '2026',
      '04',
      '13',
      `rollout-2026-04-13T12-00-00-${sessionId}.jsonl`
    );
    fs.writeFileSync(
      sessionIndexPath,
      JSON.stringify({
        id: sessionId,
        thread_name: '缓存命中会话',
        updated_at: '2026-04-13T12:00:00.000Z'
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectPath }
      }) + '\n',
      'utf8'
    );

    const firstProjects = sessionReader.readAllProjectsFromHost();
    assert.equal(firstProjects.some((project) => project.path === projectPath), true);

    fs.openSync = function patchedOpenSync(targetPath, ...args) {
      if (targetPath === sessionIndexPath || targetPath === sessionFile) {
        throw new Error('unchanged codex metadata should come from cache');
      }
      return originalOpenSync.call(this, targetPath, ...args);
    };

    const secondProjects = sessionReader.readAllProjectsFromHost();
    assert.equal(secondProjects.some((project) => project.path === projectPath), true);
  } finally {
    fs.openSync = originalOpenSync;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost uses codex global state workspace roots to recover claude project path hints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-global-state-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'workspace-demo');
    const sanitizedDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeProjectDir = path.join(root, '.claude', 'projects', sanitizedDirName);
    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(claudeProjectDir);
    fs.ensureDirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': [realProjectPath]
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(claudeProjectDir, 'demo-session.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-12T10:00:00.000Z',
        message: {
          content: '使用 codex global state 里的 workspace root 恢复路径'
        }
      }) + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'claude');
    assert.ok(project);
    assert.equal(project.path, realProjectPath);
    assert.equal(project.name, path.basename(realProjectPath));
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost prefers claude transcript cwd over sanitized path guessing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-cwd-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'demo.v2-app');
    const sanitizedDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeProjectDir = path.join(root, '.claude', 'projects', sanitizedDirName);
    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(claudeProjectDir);
    fs.writeFileSync(
      path.join(claudeProjectDir, 'demo-session.jsonl'),
      [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: realProjectPath,
          session_id: 'demo-session'
        }),
        JSON.stringify({
          type: 'user',
          cwd: realProjectPath,
          timestamp: '2026-04-14T12:00:00.000Z',
          message: {
            content: '优先使用 transcript cwd'
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'claude');
    assert.ok(project);
    assert.equal(project.path, realProjectPath);
    assert.equal(project.name, path.basename(realProjectPath));
    assert.equal(project.sessions[0].projectDirName, sanitizedDirName);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost keeps Claude sidechains intact while exposing only the main thread', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-sidechain-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-repair-demo');
    const sanitizedDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeProjectDir = path.join(root, '.claude', 'projects', sanitizedDirName);
    const sessionId = 'demo-session';
    const sessionPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);
    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(claudeProjectDir);
    fs.ensureDirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': [realProjectPath]
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(root, '.claude', 'history.jsonl'),
      `${JSON.stringify({
        display: '真实主线程问题',
        project: realProjectPath,
        sessionId
      })}\n`,
      'utf8'
    );
    const originalContent = [
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        timestamp: '2026-04-14T10:00:00.000Z',
        message: { content: 'Warmup' }
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-04-14T10:00:01.000Z',
        message: { content: [{ type: 'text', text: 'sidechain warmup' }] }
      }),
      ...Array.from({ length: 80 }, (_item, index) => JSON.stringify({
        type: 'file-history-snapshot',
        isSidechain: false,
        snapshot: { placeholder: `${index}:${'x'.repeat(300)}` }
      })),
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        timestamp: '2026-04-14T10:00:02.000Z',
        message: { content: '真实主线程问题' }
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-04-14T10:00:03.000Z',
        message: { content: [{ type: 'text', text: '主线程回复' }] }
      }),
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        timestamp: '2026-04-14T10:00:04.000Z',
        message: { content: 'subagent details' }
      })
    ].join('\n') + '\n';
    assert.ok(
      Buffer.from(originalContent).indexOf(Buffer.from('真实主线程问题')) > 16 * 1024,
      'main-thread title must sit beyond the fast transcript scan window'
    );
    fs.writeFileSync(sessionPath, originalContent, 'utf8');

    const projects = sessionReader.readAllProjectsFromHost();
    const project = projects.find((item) => item.provider === 'claude');
    assert.ok(project);
    assert.equal(project.path, realProjectPath);
    assert.equal(project.sessions.length, 1);
    assert.equal(project.sessions[0].title, '真实主线程问题');

    assert.equal(fs.readFileSync(sessionPath, 'utf8'), originalContent);

    const messages = sessionReader.readSessionMessages('claude', {
      sessionId,
      projectDirName: sanitizedDirName
    });
    assert.deepEqual(
      messages.map((item) => ({ role: item.role, content: item.content })),
      [
        { role: 'user', content: '真实主线程问题' },
        { role: 'assistant', content: '主线程回复' }
      ]
    );
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages merges claude inline image with missing image-cache metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-inline-image-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-image-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-image-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);
    const missingImagePath = path.join(root, '.claude', 'image-cache', sessionId, '1.png');

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-06T14:55:53.215Z',
          message: {
            content: [
              { type: 'text', text: '请看这里 [Image #1]' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'abc123'
                }
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          timestamp: '2026-06-06T14:55:53.215Z',
          message: {
            content: [
              { type: 'text', text: `[Image: source: ${missingImagePath}]` }
            ]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '请看这里 [Image #1]');
    assert.deepEqual(messages[0].images, ['data:image/png;base64,abc123']);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages hides claude resume meta prompt and its synthetic receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-resume-meta-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-resume-meta-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-resume-meta-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          isMeta: true,
          uuid: 'resume-meta-user',
          timestamp: '2026-07-20T07:59:23.943Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Continue from where you left off.' }]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          parentUuid: 'resume-meta-user',
          timestamp: '2026-07-20T07:59:23.943Z',
          message: {
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: 'No response requested.' }]
          }
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'real-user',
          timestamp: '2026-07-20T07:59:34.635Z',
          message: { role: 'user', content: 'hello' }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    assert.deepEqual(
      sessionReader.readSessionMessages('claude', { sessionId, projectDirName }),
      [{ role: 'user', content: 'hello', timestamp: '2026-07-20T07:59:34.635Z' }]
    );
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages prefers existing claude image-cache path over inline base64', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-image-path-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-image-path-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-image-path-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);
    const imagePath = path.join(root, '.claude', 'image-cache', sessionId, '1.png');

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.ensureDirSync(path.dirname(imagePath));
    fs.writeFileSync(imagePath, Buffer.from('fake-image'));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-06T14:55:53.215Z',
          message: {
            content: [
              { type: 'text', text: '请看这里 [Image #1]' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'abc123'
                }
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          timestamp: '2026-06-06T14:55:53.215Z',
          message: {
            content: [
              { type: 'text', text: `[Image: source: ${imagePath}]` }
            ]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '请看这里 [Image #1]');
    assert.deepEqual(messages[0].images, [imagePath]);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps claude inline fallback when only some image-cache paths exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-partial-image-path-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-partial-image-path-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-partial-image-path-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);
    const existingImagePath = path.join(root, '.claude', 'image-cache', sessionId, '1.png');
    const missingImagePath = path.join(root, '.claude', 'image-cache', sessionId, '2.png');

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.ensureDirSync(path.dirname(existingImagePath));
    fs.writeFileSync(existingImagePath, Buffer.from('fake-image'));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-06T14:55:53.215Z',
          message: {
            content: [
              { type: 'text', text: '请看两张图 [Image #1] [Image #2]' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'first'
                }
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: 'second'
                }
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          timestamp: '2026-06-06T14:55:53.215Z',
          message: {
            content: [
              { type: 'text', text: `[Image: source: ${existingImagePath}]\n[Image: source: ${missingImagePath}]` }
            ]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '请看两张图 [Image #1] [Image #2]');
    assert.deepEqual(messages[0].images, [
      existingImagePath,
      'data:image/jpeg;base64,second'
    ]);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages merges claude assistant thinking and tool calls into one assistant message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-assistant-merge-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-assistant-merge-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-assistant-merge-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-05T10:50:25.924Z',
          message: { content: '审查 WebUI' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-05T10:50:35.564Z',
          message: {
            model: 'claude-opus-4-6-thinking',
            content: [{ type: 'thinking', thinking: '先检查布局和组件边界' }]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-05T10:50:35.565Z',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: '/tmp/App.tsx' }
            }]
          }
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-05T10:50:35.998Z',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '1\\tconst App = () => null;'
            }]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-05T10:50:45.992Z',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Glob',
              input: { pattern: 'web/src/**/*.tsx' }
            }]
          }
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-05T10:50:45.998Z',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: 'web/src/App.tsx'
            }]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-05T10:50:46.200Z',
          message: { content: [{ type: 'text', text: '审查完成。' }] }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[0].model, 'claude-opus-4-6-thinking');
    assert.equal(messages[1].model, 'claude-opus-4-6-thinking');
    assert.match(messages[1].content, /:::thinking\n先检查布局和组件边界\n:::/);
    assert.match(messages[1].content, /:::tool\{name="Read"\}/);
    assert.match(messages[1].content, /:::tool-result\n1\\tconst App = \(\) => null;/);
    assert.match(messages[1].content, /:::tool\{name="Glob"\}/);
    assert.match(messages[1].content, /审查完成。/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps adjacent claude api errors from different requests separate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-api-error-boundary-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-api-error-boundary-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-api-error-boundary-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-07-20T06:48:36.484Z',
          message: { role: 'user', content: 'hello' },
          entrypoint: 'cli'
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-webui-error',
          parentUuid: 'webui-user',
          requestId: '2026072014495472cef27200e648c1',
          timestamp: '2026-07-20T06:49:54.870Z',
          message: {
            id: 'webui-error-message',
            role: 'assistant',
            content: [{
              type: 'text',
              text: 'API Error: Request rejected (429) · [1113][余额不足或无可用资源包,请充值。][2026072014495472cef27200e648c1]'
            }]
          },
          isApiErrorMessage: true,
          entrypoint: 'sdk-cli'
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-cli-error',
          parentUuid: 'cli-user',
          requestId: '20260720145139c11f895c8c8a4fb9',
          timestamp: '2026-07-20T06:51:39.106Z',
          message: {
            id: 'cli-error-message',
            role: 'assistant',
            content: [{
              type: 'text',
              text: 'API Error: Request rejected (429) · [1113][余额不足或无可用资源包,请充值。][20260720145139c11f895c8c8a4fb9]'
            }]
          },
          isApiErrorMessage: true,
          entrypoint: 'cli'
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, 'assistant');
    assert.match(messages[1].content, /2026072014495472cef27200e648c1/);
    assert.doesNotMatch(messages[1].content, /20260720145139c11f895c8c8a4fb9/);
    assert.equal(messages[2].role, 'assistant');
    assert.match(messages[2].content, /20260720145139c11f895c8c8a4fb9/);
    assert.doesNotMatch(messages[2].content, /2026072014495472cef27200e648c1/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps claude images returned by tool_result content arrays', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-tool-result-image-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-tool-image-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-tool-result-image-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-08T10:00:00.000Z',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_image',
              name: 'Read',
              input: { file_path: '/tmp/screenshot.png' }
            }]
          }
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-08T10:00:01.000Z',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_image',
              content: [
                { type: 'text', text: 'Image loaded from /tmp/screenshot.png' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'toolimage'
                  }
                }
              ]
            }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="Read"\}/);
    assert.match(messages[0].content, /:::tool-result\nImage loaded from \/tmp\/screenshot\.png\n\[Image #1\]/);
    assert.deepEqual(messages[0].images, ['data:image/png;base64,toolimage']);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages rebases repeated claude tool image markers after assistant merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-tool-image-rebase-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const realProjectPath = path.join(root, 'feature', 'claude-tool-image-rebase-demo');
    const projectDirName = realProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const sessionId = 'claude-tool-image-rebase-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);

    fs.ensureDirSync(realProjectPath);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-08T10:00:00.000Z',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_first_image',
              name: 'Read',
              input: { file_path: '/tmp/first.png' }
            }]
          }
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-08T10:00:01.000Z',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_first_image',
              content: [{
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'firstimage'
                }
              }]
            }]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-08T10:00:02.000Z',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_second_image',
              name: 'Read',
              input: { file_path: '/tmp/second.png' }
            }]
          }
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-08T10:00:03.000Z',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_second_image',
              content: [{
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'secondimage'
                }
              }]
            }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.deepEqual(messages[0].images, [
      'data:image/png;base64,firstimage',
      'data:image/png;base64,secondimage'
    ]);
    assert.match(messages[0].content, /\/tmp\/first\.png[\s\S]*\[Image #1\]/);
    assert.match(messages[0].content, /\/tmp\/second\.png[\s\S]*\[Image #2\]/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAllProjectsFromHost includes codex workspace roots from global state even without session files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-workspace-roots-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectA = path.join(root, 'workspace-a');
    const projectB = path.join(root, 'workspace-b');
    fs.ensureDirSync(projectA);
    fs.ensureDirSync(projectB);
    fs.ensureDirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      `[projects."${projectA}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(root, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'project-order': [projectB],
        'active-workspace-roots': [projectA]
      }),
      'utf8'
    );

    const projects = sessionReader.readAllProjectsFromHost();
    const paths = projects
      .filter((item) => item.provider === 'codex')
      .map((item) => item.path);

    assert.equal(paths.includes(projectA), true);
    assert.equal(paths.includes(projectB), true);
    const project = projects.find((item) => item.path === projectB);
    assert.ok(project);
    assert.deepEqual(project.sessions, []);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages strips codex exec_command noise and keeps only real output text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-output-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T12-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T12:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_exec_build',
            arguments: JSON.stringify({
              cmd: 'npm run web:build',
              workdir: '/Users/model/projects/feature/ai_home'
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            name: 'exec_command',
            call_id: 'call_exec_build',
            output: [
              'Chunk ID: 0bbc4e',
              'Wall time: 1.0022 seconds',
              'Process running with session ID 44030',
              'Original token count: 26',
              'Output:',
              '',
              '> ai_home@1.0.0 web:build',
              '> cd web && npm run build',
              '',
              'Chunk ID: a4b588',
              'Wall time: 1.0019 seconds',
              'Process running with session ID 53604',
              'Original token count: 0',
              'Output:'
            ].join('\n')
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="Terminal"\}/);
    assert.match(messages[0].content, /npm run web:build/);
    assert.match(messages[0].content, /> ai_home@1\.0\.0 web:build/);
    assert.doesNotMatch(messages[0].content, /Chunk ID:/);
    assert.doesNotMatch(messages[0].content, /Wall time:/);
    assert.doesNotMatch(messages[0].content, /Original token count:/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages merges codex assistant tool calls into one assistant message and skips transient tool noise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-merge-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T13-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T13:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '继续处理聊天 UI' }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:01.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: '我先定位消息卡片和样式文件。' }]
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_read_bubble',
            arguments: JSON.stringify({
              cmd: 'sed -n \'1,220p\' "/Users/model/projects/feature/ai_home/web/src/components/chat/MessageBubble.tsx"',
              workdir: '/Users/model/projects/feature/ai_home'
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            name: 'exec_command',
            call_id: 'call_read_bubble',
            output: 'Output:\nimport { memo } from \'react\';'
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'write_stdin',
            call_id: 'call_poll_noise',
            arguments: JSON.stringify({
              session_id: 53091,
              chars: '',
              yield_time_ms: 1000,
              max_output_tokens: 12000
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T13:00:05.000Z',
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: '我现在开始改消息卡片显隐交互。' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.match(messages[1].content, /我先定位消息卡片和样式文件。/);
    assert.match(messages[1].content, /:::tool\{name="Terminal"\}/);
    assert.match(messages[1].content, /MessageBubble\.tsx/);
    assert.match(messages[1].content, /我现在开始改消息卡片显隐交互。/);
    assert.doesNotMatch(messages[1].content, /"session_id":53091/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages keeps codex user images when response_item and event_msg duplicate the same user turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-images-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '11');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-11T18-14-57-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-11T18:14:57.319Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'codex 渲染 shell 图 1\n我们 web 渲染 图 2'
              },
              { type: 'input_text', text: '<image>' },
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,abc123'
              },
              { type: 'input_text', text: '</image>' }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-11T18:14:57.319Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'codex 渲染 shell 图 1\n我们 web 渲染 图 2',
            images: ['data:image/png;base64,abc123'],
            local_images: []
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'codex 渲染 shell 图 1\n我们 web 渲染 图 2');
    assert.deepEqual(messages[0].images, ['data:image/png;base64,abc123']);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages merges codex image user turn and prefers inline renderable images', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-multi-image-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '65656565-6565-4565-8565-656565656565';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '11');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-11T19-14-57-${sessionId}.jsonl`);
    const localImageOne = path.join(root, 'codex-clipboard-one.png');
    const localImageTwo = path.join(root, 'codex-clipboard-two.png');
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(localImageOne, Buffer.from('local-one'));
    fs.writeFileSync(localImageTwo, Buffer.from('local-two'));
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-11T19:14:57.255Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '<image name=[Image #1]>' },
              { type: 'input_image', image_url: 'data:image/png;base64,first' },
              { type: 'input_text', text: '</image>' },
              { type: 'input_text', text: '<image name=[Image #2]>' },
              { type: 'input_image', image_url: 'data:image/png;base64,second' },
              { type: 'input_text', text: '</image>' },
              { type: 'input_text', text: '[Image #1] 这里是一 [Image #2] 这里是二' }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-11T19:14:57.256Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '[Image #1] 这里是一 [Image #2] 这里是二',
            images: [],
            local_images: [localImageOne, localImageTwo]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '[Image #1] 这里是一 [Image #2] 这里是二');
    assert.deepEqual(messages[0].images, [
      'data:image/png;base64,first',
      'data:image/png;base64,second'
    ]);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages prefers codex exec_command_end aggregated output and parsed command metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-exec-end-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '11');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-11T18-15-18-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-11T18:15:18.742Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: 'sed -n \'220,360p\' "/Users/model/projects/feature/ai_home/web/src/components/chat/chat.module.css"',
              workdir: '/Users/model/projects/feature/ai_home',
              yield_time_ms: 1000,
              max_output_tokens: 12000
            }),
            call_id: 'call_figfoUbZusu37gzp6c2gTaDF'
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-11T18:15:23.336Z',
          type: 'event_msg',
          payload: {
            type: 'exec_command_end',
            call_id: 'call_figfoUbZusu37gzp6c2gTaDF',
            cwd: '/Users/model/projects/feature/ai_home',
            parsed_cmd: [{
              type: 'read',
              cmd: 'sed -n \'220,360p\' /Users/model/projects/feature/ai_home/web/src/components/chat/chat.module.css',
              name: 'chat.module.css',
              path: '/Users/model/projects/feature/ai_home/web/src/components/chat/chat.module.css'
            }],
            aggregated_output: '.bubbleAssistant {\n  padding: 12px 16px;\n}\n\n.pendingShell {\n  position: relative;\n}\n',
            stdout: '',
            stderr: '',
            exit_code: 0
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="Read"\}/);
    assert.match(messages[0].content, /chat\.module\.css/);
    assert.match(messages[0].content, /\.bubbleAssistant/);
    assert.doesNotMatch(messages[0].content, /Chunk ID:/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents skips AGY snapshot fallback when its transcript cursor is unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-agy-events-unchanged-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'agy-events-unchanged';
    const sessionFile = path.join(
      root,
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    fs.ensureDirSync(path.dirname(sessionFile));
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-07-20T07:08:36Z',
      content: '继续处理'
    }) + '\n', 'utf8');
    const cursor = fs.statSync(sessionFile).size;

    const payload = sessionReader.readSessionEvents('agy', { sessionId }, { cursor });

    assert.equal(payload.cursor, cursor);
    assert.deepEqual(payload.events, []);
    assert.equal(payload.requiresSnapshot, false);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents requests AGY snapshot fallback only when its transcript cursor advances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-agy-events-advanced-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'agy-events-advanced';
    const sessionFile = path.join(
      root,
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    fs.ensureDirSync(path.dirname(sessionFile));
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: 'USER_INPUT',
      created_at: '2026-07-20T07:07:41Z',
      content: '<USER_REQUEST>继续</USER_REQUEST>'
    }) + '\n', 'utf8');
    const cursor = fs.statSync(sessionFile).size;
    fs.appendFileSync(sessionFile, JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-07-20T07:08:36Z',
      content: '继续处理'
    }) + '\n', 'utf8');

    const payload = sessionReader.readSessionEvents('agy', { sessionId }, { cursor });

    assert.ok(payload.cursor > cursor);
    assert.deepEqual(payload.events, []);
    assert.equal(payload.requiresSnapshot, true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents returns codex incremental events with cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T14-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);

    const firstLine = JSON.stringify({
      timestamp: '2026-04-12T14:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello with image' }, { type: 'input_image', image_url: 'data:image/png;base64,evtimg' }]
      }
    }) + '\n';
    fs.writeFileSync(sessionFile, firstLine, 'utf8');

    const cursor = Buffer.byteLength(firstLine, 'utf8');
    fs.appendFileSync(sessionFile, [
      JSON.stringify({
        timestamp: '2026-04-12T14:00:00.500Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-events', model: 'gpt-5.6-sol' }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T14:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning', text: '**Thinking about patch**' }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T14:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'call_delta_read',
          cwd: '/Users/model/projects/feature/ai_home',
          command: ['/bin/zsh', '-lc', 'sed -n \'1,40p\' "/tmp/demo.txt"'],
          parsed_cmd: [{ type: 'read', name: 'demo.txt', path: '/tmp/demo.txt' }],
          aggregated_output: 'line1\nline2',
          exit_code: 0
        }
      }),
      ''
    ].join('\n'), 'utf8');

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor });
    assert.ok(payload.cursor > cursor);
    assert.equal(Array.isArray(payload.events), true);
    assert.equal(payload.events.length, 2);
    assert.equal(payload.events[0].type, 'assistant_reasoning');
    assert.equal(payload.events[0].model, 'gpt-5.6-sol');
    assert.equal(payload.events[1].type, 'assistant_tool_result');
    assert.equal(payload.events[1].model, 'gpt-5.6-sol');
    assert.match(payload.events[1].content, /:::tool\{name="Read"\}/);
    assert.match(payload.events[1].content, /demo\.txt/);
    assert.match(payload.events[1].content, /line1/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents merges duplicate codex image user events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-image-events-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '78787878-7878-4787-8787-787878787878';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T15-00-00-${sessionId}.jsonl`);
    const localImageOne = path.join(root, 'codex-clipboard-one.png');
    const localImageTwo = path.join(root, 'codex-clipboard-two.png');
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(localImageOne, Buffer.from('local-one'));
    fs.writeFileSync(localImageTwo, Buffer.from('local-two'));
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        timestamp: '2026-04-12T15:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1]>' },
            { type: 'input_image', image_url: 'data:image/png;base64,first' },
            { type: 'input_text', text: '</image>' },
            { type: 'input_text', text: '<image name=[Image #2]>' },
            { type: 'input_image', image_url: 'data:image/png;base64,second' },
            { type: 'input_text', text: '</image>' },
            { type: 'input_text', text: '[Image #1] 这里是一 [Image #2] 这里是二' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T15:00:00.102Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '[Image #1] 这里是一 [Image #2] 这里是二',
          images: [],
          local_images: [localImageOne, localImageTwo]
        }
      }),
      ''
    ].join('\n'), 'utf8');

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].type, 'user_message');
    assert.equal(payload.events[0].content, '[Image #1] 这里是一 [Image #2] 这里是二');
    assert.deepEqual(payload.events[0].images, [
      'data:image/png;base64,first',
      'data:image/png;base64,second'
    ]);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents requests snapshot fallback when codex emits raw function_call_output delta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '88888888-8888-4888-8888-888888888888';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T15-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T15:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_raw_delta',
          output: 'Chunk ID: abc123\nWall time: 0.1 seconds\nOutput:\nraw text'
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.requiresSnapshot, true);
    assert.deepEqual(payload.events, []);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents emits assistant_tool_call for codex function_call deltas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-tool-call-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '99999999-9999-4999-8999-999999999999';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T16-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T16:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_tool_delta',
          arguments: JSON.stringify({
            cmd: 'sed -n \'1,20p\' "/tmp/demo.txt"',
            workdir: '/Users/model/projects/feature/ai_home'
          })
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.requiresSnapshot, false);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].type, 'assistant_tool_call');
    assert.equal(payload.hasAssistantToolCall, true);
    assert.match(payload.events[0].content, /:::tool\{name="Terminal"\}/);
    assert.match(payload.events[0].content, /sed -n/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents emits request_user_input as structured assistant tool call', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-user-input-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '99999999-9999-4999-8999-999999999998';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T16-30-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T16:30:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'call_user_input_delta',
          arguments: JSON.stringify({
            questions: [
              {
                id: 'scope',
                header: '范围',
                question: '是否同步渲染确认项？',
                options: [
                  { label: '同步渲染', description: '计划过程中立即展示。' },
                  { label: '稍后处理', description: '只保留原始文本。' }
                ]
              }
            ]
          })
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.requiresSnapshot, false);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].type, 'assistant_tool_call');
    assert.match(payload.events[0].content, /:::tool\{name="request_user_input"\}/);
    assert.match(payload.events[0].content, /是否同步渲染确认项/);
    assert.match(payload.events[0].content, /同步渲染/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents requests snapshot fallback when codex cursor advances but no supported incremental events are produced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-empty-fallback-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T17-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        timestamp: '2026-04-12T17:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'ignored_event_shape',
          foo: 'bar'
        }
      }) + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.ok(payload.cursor > 0);
    assert.deepEqual(payload.events, []);
    assert.equal(payload.requiresSnapshot, true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents emits codex goal XML user context and skips other synthetic XML', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-events-synthetic-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '06', '08');
    const sessionFile = path.join(sessionDir, `rollout-2026-06-08T09-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-06-08T09:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<environment_context>\n<timezone>Asia/Shanghai</timezone>\n</environment_context>'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T09:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<codex_internal_context source="goal">\n<objective>内部续跑目标</objective>\n</codex_internal_context>'
              }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T09:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<goal_context>\n<objective>旧版目标上下文</objective>\n</goal_context>'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-08T09:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn_aborted',
            turn_id: 'turn-1'
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.ok(payload.cursor > 0);
    assert.deepEqual(
      payload.events.map((item) => ({ type: item.type, content: item.content })),
      [
        {
          type: 'user_message',
          content: '<codex_internal_context source="goal">\n<objective>内部续跑目标</objective>\n</codex_internal_context>'
        },
        {
          type: 'user_message',
          content: '<goal_context>\n<objective>旧版目标上下文</objective>\n</goal_context>'
        }
      ]
    );
    assert.equal(payload.requiresSnapshot, false);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages renders codex update_plan tool calls as structured Task blocks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-plan-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T15-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T15:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call_plan_1',
            arguments: JSON.stringify({
              explanation: '按顺序处理问题',
              tasks: [
                { step: '先定位问题', status: 'completed' },
                { step: '补持久化修复', status: 'in_progress' },
                { step: '验证并回归', status: 'pending' }
              ]
            })
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="update_plan"\}/);
    assert.match(messages[0].content, /按顺序处理问题/);
    assert.match(messages[0].content, /先定位问题/);
    assert.match(messages[0].content, /补持久化修复/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages renders codex goal and user confirmation tool calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-codex-goal-input-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '77777777-7777-4777-8777-777777777776';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '04', '12');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-12T15-30-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: '2026-04-12T15:30:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'create_goal',
            call_id: 'call_goal_1',
            arguments: JSON.stringify({
              objective: '让 WebUI 渲染 goal 和确认项',
              token_budget: 1200
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T15:30:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_goal_1',
            output: JSON.stringify({
              goal: {
                objective: '让 WebUI 渲染 goal 和确认项',
                status: 'active',
                tokenBudget: 1200,
                tokensUsed: 20
              }
            })
          }
        }),
        JSON.stringify({
          timestamp: '2026-04-12T15:30:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'request_user_input',
            call_id: 'call_user_input_1',
            arguments: JSON.stringify({
              questions: [
                {
                  id: 'approval',
                  header: '确认',
                  question: '是否进入 Plan 模式？',
                  options: [
                    { label: '进入', description: '展示需要用户确认的数据。' },
                    { label: '跳过', description: '只继续普通对话。' }
                  ]
                }
              ]
            })
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('codex', { sessionId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.match(messages[0].content, /:::tool\{name="create_goal"\}/);
    assert.match(messages[0].content, /让 WebUI 渲染 goal 和确认项/);
    assert.match(messages[0].content, /:::tool-result/);
    assert.match(messages[0].content, /:::tool\{name="request_user_input"\}/);
    assert.match(messages[0].content, /是否进入 Plan 模式/);
    assert.match(messages[0].content, /展示需要用户确认的数据/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages reads gemini JSONL thoughts and tool calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-gemini-jsonl-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'gemini-jsonl-session-id';
    const projectDirName = 'project-admin';
    const chatsDir = path.join(root, '.gemini', 'tmp', projectDirName, 'chats');
    const sessionPath = path.join(chatsDir, 'session-2026-05-23T05-24-4de3a088.jsonl');
    fs.ensureDirSync(chatsDir);
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          sessionId,
          projectHash: 'hash',
          startTime: '2026-05-23T05:24:06.752Z',
          kind: 'main'
        }),
        JSON.stringify({
          id: 'user-1',
          timestamp: '2026-05-23T05:24:37.723Z',
          type: 'user',
          content: [{ text: '你好' }]
        }),
        JSON.stringify({
          id: 'assistant-1',
          timestamp: '2026-05-23T05:25:01.463Z',
          type: 'gemini',
          content: '你好！',
          thoughts: [
            {
              subject: 'Responding with Greetings',
              description: 'Preparing a suitable acknowledgment.'
            }
          ],
          toolCalls: [
            {
              id: 'tool-1',
              name: 'update_topic',
              args: { strategic_intent: 'Greeting the user.' },
              resultDisplay: '> [!STRATEGY]\n> Greeting the user.'
            }
          ]
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('gemini', { sessionId, projectDirName });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '你好');
    assert.equal(messages[1].role, 'assistant');
    assert.match(messages[1].content, /:::thinking/);
    assert.match(messages[1].content, /Responding with Greetings/);
    assert.match(messages[1].content, /你好！/);
    assert.match(messages[1].content, /:::tool\{name="update_topic"\}/);
    assert.match(messages[1].content, /Greeting the user/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages finds archived gemini JSON session files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-gemini-archived-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'archived-gemini-session-id';
    const projectDirName = 'ai-home';
    const chatsDir = path.join(root, '.gemini', 'tmp', projectDirName, 'chats', '.archived');
    fs.ensureDirSync(chatsDir);
    fs.writeFileSync(
      path.join(chatsDir, 'session-2026-04-05T16-18-41c07769.json'),
      JSON.stringify({
        sessionId,
        messages: [
          {
            type: 'user',
            timestamp: '2026-04-05T16:18:00.000Z',
            content: [{ text: '分析旧格式' }]
          },
          {
            type: 'gemini',
            timestamp: '2026-04-05T16:18:01.000Z',
            content: '旧格式回复',
            thoughts: [{ subject: 'Legacy', description: 'Reading legacy JSON.' }],
            toolCalls: [
              {
                name: 'read_file',
                args: { path: 'README.md' },
                result: 'ok'
              }
            ]
          }
        ]
      }),
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('gemini', { sessionId, projectDirName });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, '分析旧格式');
    assert.match(messages[1].content, /旧格式回复/);
    assert.match(messages[1].content, /:::thinking/);
    assert.match(messages[1].content, /:::tool\{name="read_file"\}/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages reads AGY transcript timeline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-agy-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = 'agy-session-id';
    const logsDir = path.join(root, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs');
    const legacyArtifact = path.join(
      root,
      '.ai_home',
      'profiles',
      'agy',
      '1',
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      'artifact.md'
    );
    const currentImage = path.join(
      root,
      '.ai_home',
      'run',
      'auth-projections',
      'agy',
      'acct_0123456789abcdef0123',
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      'image.jpg'
    );
    fs.ensureDirSync(logsDir);
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-05-23T11:37:37Z',
          content: '<USER_REQUEST>\n检查项目\n</USER_REQUEST>\n<ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>'
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-05-23T11:37:38Z',
          content: `查看 [artifact](file://${legacyArtifact})`,
          tool_calls: [
            {
              name: 'list_dir',
              args: {
                DirectoryPath: '"/tmp/project"',
                toolAction: '"Listing workspace directory"',
                TargetFile: currentImage
              }
            }
          ]
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'RUN_COMMAND',
          status: 'DONE',
          created_at: '2026-05-23T11:37:39Z',
          content: 'Created At: now\nCompleted At: now\nOutput:\nREADME.md'
        }),
        JSON.stringify({
          step_index: 3,
          source: 'SYSTEM',
          type: 'CHECKPOINT',
          status: 'DONE',
          created_at: '2026-05-23T11:37:40Z',
          content: '# Resuming from a compaction'
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('agy', { sessionId });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '检查项目');
    assert.equal(messages[1].role, 'assistant');
    assert.match(messages[1].content, /:::tool\{name="list_dir"\}/);
    assert.match(messages[1].content, /Listing workspace directory/);
    assert.match(messages[1].content, /:::tool\{name="Terminal"\}/);
    assert.match(messages[1].content, /README\.md/);
    assert.match(messages[1].content, new RegExp(
      path.join(root, '.gemini', 'antigravity-cli', 'brain', sessionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ));
    assert.equal(messages[1].content.includes(path.join(root, '.ai_home', 'profiles')), false);
    assert.equal(messages[1].content.includes(path.join(root, '.ai_home', 'run', 'auth-projections')), false);
    // antigravity 内部 planner CHECKPOINT 是纯噪声，不再渲染进消息内容（fix: agy checkpoint noise）。
    assert.ok(!/<checkpoint>/.test(messages[1].content));
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionMessages renders claude plan mode and task lifecycle as canonical blocks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-claude-plan-mode-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectDirName = '-Users-model-projects-feature-ai-home';
    const sessionId = 'claude-plan-mode-session';
    const sessionPath = path.join(root, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);
    fs.ensureDirSync(path.dirname(sessionPath));
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-09T09:00:00.000Z',
          message: { content: '先给计划' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-09T09:00:01.000Z',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'plan-tool',
                name: 'ExitPlanMode',
                input: {
                  plan: '1. 抽 adapter\n2. 接 UI\n3. 验证'
                }
              },
              {
                type: 'tool_use',
                id: 'task-create-tool',
                name: 'TaskCreate',
                input: {
                  taskId: 'task-1',
                  subject: '实现 provider adapter',
                  status: 'running'
                }
              },
              {
                type: 'tool_use',
                id: 'task-update-tool',
                name: 'TaskUpdate',
                input: {
                  taskId: 'task-1',
                  status: 'completed',
                  summary: 'adapter 已完成'
                }
              }
            ]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = sessionReader.readSessionMessages('claude', { sessionId, projectDirName });
    assert.equal(messages.length, 2);
    assert.equal(messages[1].role, 'assistant');
    assert.match(messages[1].content, /<proposed_plan>/);
    assert.match(messages[1].content, /抽 adapter/);
    assert.doesNotMatch(messages[1].content, /:::tool\{name="ExitPlanMode"\}/);
    assert.match(messages[1].content, /<task-notification>/);
    assert.match(messages[1].content, /实现 provider adapter/);
    assert.match(messages[1].content, /adapter 已完成/);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents keeps its cursor before an incomplete JSONL tail and reads it after append', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-partial-jsonl-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '12121212-1212-4212-8212-121212121212';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T12-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    const completeLine = `${JSON.stringify({
      timestamp: '2026-07-14T12:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_reasoning', text: '先分析' }
    })}\n`;
    const appendedLine = JSON.stringify({
      timestamp: '2026-07-14T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '追加完成' }]
      }
    });
    const splitAt = appendedLine.length - 7;
    fs.writeFileSync(sessionFile, completeLine + appendedLine.slice(0, splitAt), 'utf8');

    const first = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    const completeCursor = Buffer.byteLength(completeLine, 'utf8');
    assert.equal(first.cursor, completeCursor);
    assert.ok(first.cursor < fs.statSync(sessionFile).size);
    assert.deepEqual(first.events.map((event) => event.type), ['assistant_reasoning']);

    fs.appendFileSync(sessionFile, `${appendedLine.slice(splitAt)}\n`, 'utf8');
    const second = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: first.cursor });
    assert.equal(second.cursor, fs.statSync(sessionFile).size);
    assert.deepEqual(second.events.map((event) => event.type), ['assistant_text']);
    assert.equal(second.events[0].text, '追加完成');
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents preserves UTF-8 text split across the JSONL read chunk boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-utf8-chunk-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '13131313-1313-4313-8313-131313131313';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T12-10-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    const marker = '界';
    const buildLine = (message) => JSON.stringify({
      timestamp: '2026-07-14T12:10:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message }
    });
    const markerPrefixBytes = Buffer.byteLength(buildLine(marker).split(marker)[0], 'utf8');
    const markerByteOffset = 256 * 1024 - 1;
    const message = `${'a'.repeat(markerByteOffset - markerPrefixBytes)}${marker}完成`;
    const line = `${buildLine(message)}\n`;
    assert.equal(Buffer.from(line).indexOf(Buffer.from(marker)), markerByteOffset);
    fs.writeFileSync(sessionFile, line, 'utf8');

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.cursor, fs.statSync(sessionFile).size);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].content, message);
    assert.doesNotMatch(payload.events[0].content, /�/u);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents returns the complete cursor and tool boundary flag when events exceed four MiB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-events-overflow-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '14141414-1414-4414-8414-141414141414';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T12-20-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    const largeText = 'x'.repeat(1536 * 1024);
    const records = [
      {
        timestamp: '2026-07-14T12:20:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-before-overflow',
          arguments: JSON.stringify({ cmd: 'pwd' })
        }
      },
      ...Array.from({ length: 3 }, (_item, index) => ({
        timestamp: `2026-07-14T12:20:0${index + 1}.000Z`,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `${index}:${largeText}` }]
        }
      }))
    ];
    fs.writeFileSync(sessionFile, `${records.map(JSON.stringify).join('\n')}\n`, 'utf8');

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.cursor, fs.statSync(sessionFile).size);
    assert.deepEqual(payload.events, []);
    assert.equal(payload.requiresSnapshot, true);
    assert.equal(payload.hasAssistantToolCall, true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionEvents does not report filtered Codex transport calls as assistant tool boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-filtered-tool-call-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const sessionId = '15151515-1515-4515-8515-151515151515';
    const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
    const sessionFile = path.join(sessionDir, `rollout-2026-07-14T12-30-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, `${JSON.stringify({
      timestamp: '2026-07-14T12:30:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'write_stdin',
        call_id: 'call-filtered-transport',
        arguments: JSON.stringify({ session_id: 123, chars: '' })
      }
    })}\n`, 'utf8');

    const payload = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });
    assert.equal(payload.hasAssistantToolCall, false);
    assert.deepEqual(payload.events, []);
    assert.equal(payload.requiresSnapshot, true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
