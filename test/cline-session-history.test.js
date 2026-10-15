'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  readProjectsFromHostByProviders,
  readSessionMessages,
  resolveSessionFilePath,
  readSessionLastModel
} = require('../lib/sessions/session-reader');

const SESSION_ID = '1792050248852_or8f0';
const PROJECT_PATH = '/work/alpha';
const ACCOUNT_REF = 'acct_00000000000000000001';

const SESSIONS_SCHEMA = `CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  cwd TEXT,
  workspace_root TEXT,
  prompt TEXT,
  model TEXT,
  provider TEXT,
  messages_path TEXT
)`;

function makeProjection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-history-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const dataDir = path.join(aiHomeDir, 'run', 'auth-projections', 'cline', ACCOUNT_REF, '.cline', 'data');
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'sessions', SESSION_ID), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'db', 'sessions.db'));
  try {
    db.exec(SESSIONS_SCHEMA);
    db.prepare(
      'INSERT INTO sessions (session_id, started_at, updated_at, status, cwd, workspace_root, prompt, model, provider, messages_path)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      SESSION_ID,
      '2026-10-15T07:44:08.855Z',
      '2026-10-15T11:24:36.167Z',
      'idle',
      PROJECT_PATH,
      PROJECT_PATH,
      '<user_input mode="act">把会话历史接进 WebUI</user_input>',
      'cline-pass/deepseek-v4.1-flash',
      'cline-pass',
      path.join(dataDir, 'sessions', SESSION_ID, `${SESSION_ID}.messages.json`)
    );
  } finally {
    db.close();
  }
  fs.writeFileSync(
    path.join(dataDir, 'sessions', SESSION_ID, `${SESSION_ID}.messages.json`),
    JSON.stringify({
      version: 1,
      sessionId: SESSION_ID,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: [{ type: 'text', text: '把会话历史接进 WebUI' }],
          ts: Date.parse('2026-10-15T07:44:12.084Z')
        },
        {
          id: 'm2',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看 reader 的接线点' },
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'lib/sessions/session-reader.js' } },
            { type: 'tool_result', tool_use_id: 't1', name: 'Read', content: 'file body' },
            { type: 'image', data: 'BASE64', mediaType: 'image/png' }
          ],
          ts: Date.parse('2026-10-15T07:44:20.000Z')
        }
      ]
    }),
    'utf8'
  );
  return { root, aiHomeDir, dataDir };
}

test('cline sessions are listed as account-scoped projects', (t) => {
  const fixture = makeProjection();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const projects = readProjectsFromHostByProviders(['cline'], {
    aiHomeDir: fixture.aiHomeDir,
    accountRef: ACCOUNT_REF
  });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].provider, 'cline');
  assert.equal(projects[0].path, PROJECT_PATH);
  assert.equal(projects[0].name, 'alpha');
  assert.equal(projects[0].sessions.length, 1);
  const session = projects[0].sessions[0];
  assert.equal(session.id, SESSION_ID);
  assert.equal(session.title, '把会话历史接进 WebUI');
  assert.equal(session.model, 'cline-pass/deepseek-v4.1-flash');
  assert.equal(session.updatedAt, Date.parse('2026-10-15T11:24:36.167Z'));
});

test('cline messages render blocks into the shared legacy content shape', (t) => {
  const fixture = makeProjection();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const options = { aiHomeDir: fixture.aiHomeDir, accountRef: ACCOUNT_REF };
  const params = { sessionId: SESSION_ID, projectDirName: PROJECT_PATH };

  assert.equal(
    resolveSessionFilePath('cline', params, options),
    path.join(fixture.dataDir, 'sessions', SESSION_ID, `${SESSION_ID}.messages.json`)
  );
  assert.equal(readSessionLastModel('cline', params, options), 'cline-pass/deepseek-v4.1-flash');

  const messages = readSessionMessages('cline', params, options);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '把会话历史接进 WebUI');
  assert.equal(messages[0].timestamp, '2026-10-15T07:44:12.084Z');
  assert.equal(messages[1].role, 'assistant');
  assert.ok(messages[1].content.includes('好的'));
  assert.ok(messages[1].content.includes(':::thinking'), 'thinking block rendered');
  assert.ok(messages[1].content.includes(':::tool{name="Read"}'), 'tool call rendered');
  assert.ok(messages[1].content.includes('file body'), 'tool result rendered');
  assert.ok(messages[1].content.includes('[image image/png]'), 'image placeholder');
});

test('unknown or foreign sessions resolve to nothing instead of guessing', (t) => {
  const fixture = makeProjection();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const options = { aiHomeDir: fixture.aiHomeDir, accountRef: ACCOUNT_REF };
  assert.deepEqual(
    readSessionMessages('cline', { sessionId: 'not-a-session-id', projectDirName: PROJECT_PATH }, options),
    []
  );
  assert.equal(resolveSessionFilePath('cline', { sessionId: '1792050100000_zzz99' }, options), '');
  assert.deepEqual(
    readProjectsFromHostByProviders(['cline'], { aiHomeDir: fixture.aiHomeDir, accountRef: 'acct_00000000000000000002' }),
    []
  );
});
