'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const reader = require('../lib/sessions/session-reader');

test('Kiro SQLite sessions are listed and restored per account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = 'acct_1234567890abcdef1234';
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'kiro', accountRef);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const db = new DatabaseSync(path.join(runtimeDir, 'data.sqlite3'));
  db.exec('CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id))');
  const value = {
    conversation_id: 'kiro-session-1',
    history: [{
      user: { content: { Prompt: { prompt: 'hello kiro' } } },
      assistant: { Response: { content: 'hello user' } },
      request_metadata: { model_id: 'kiro-model' }
    }],
    model_info: { model_id: 'kiro-model' }
  };
  db.prepare('INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)').run('C:\\work\\demo', 'kiro-session-1', JSON.stringify(value), 1, 2);
  db.close();
  const options = { aiHomeDir: root, accountRef, hostHomeDir: path.join(root, 'host') };
  const projects = reader.readProjectsFromHostByProviders(['kiro'], options);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessions[0].id, 'kiro-session-1');
  assert.deepEqual(reader.readSessionMessages('kiro', { sessionId: 'kiro-session-1' }, options).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'hello kiro' },
    { role: 'assistant', content: 'hello user' }
  ]);
  assert.equal(reader.readSessionLastModel('kiro', { sessionId: 'kiro-session-1' }, options), 'kiro-model');
});

test('new Kiro JSONL sessions expose their native history, model and timestamps alongside SQLite', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-jsonl-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = 'acct_1234567890abcdef1234';
  const sessionId = '81048851-2e98-4946-bf42-92d65689519c';
  const runtime = path.join(root, 'run', 'auth-projections', 'kiro', accountRef);
  const store = path.join(runtime, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(store, { recursive: true });
  const cwd = path.join(root, 'project');
  const options = { aiHomeDir: root, accountRef, hostHomeDir: path.join(root, 'host') };
  fs.writeFileSync(path.join(store, `${sessionId}.json`), JSON.stringify({
    session_id: sessionId, cwd, title: 'Actual native conversation', updated_at: '2026-10-07T06:30:00Z',
    session_state: { rts_model_state: { model_info: { model_id: 'auto' } },
      conversation_metadata: { user_turn_metadatas: [{ model: 'auto', message_ids: ['user-1', 'assistant-1'],
        result: { Ok: { meta: { timestamp: 1791354052 } } } }] } }
  }));
  const transcript = path.join(store, `${sessionId}.jsonl`);
  const events = [
    { version: 'v1', kind: 'Prompt', data: { message_id: 'user-1', meta: { timestamp: 1791354048 },
      content: [{ kind: 'text', data: 'hello kiro' }] } },
    { version: 'v1', kind: 'AssistantMessage', data: { message_id: 'assistant-1',
      content: [{ kind: 'thinking', data: { text: 'private reasoning' } }, { kind: 'text', data: 'hello user' }] } }
  ];
  fs.writeFileSync(transcript, events.map(JSON.stringify).join('\n') + '\n{"version":');
  const projects = reader.readProjectsFromHostByProviders(['kiro'], options);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, cwd);
  assert.equal(projects[0].accountRef, accountRef);
  assert.equal(projects[0].sessions[0].id, sessionId);
  assert.ok(projects[0].sessions[0].updatedAt >= Date.parse('2026-10-07T06:30:00Z'));
  const messages = reader.readSessionMessages('kiro', { sessionId }, options);
  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'hello kiro' }, { role: 'assistant', content: 'hello user' }
  ]);
  assert.equal(messages[0].timestamp, '2026-10-07T06:20:48.000Z');
  assert.equal(messages[1].timestamp, '2026-10-07T06:20:52.000Z');
  assert.equal(reader.readSessionLastModel('kiro', { sessionId }, options), 'auto');
  assert.equal(reader.resolveSessionFilePath('kiro', { sessionId }, options), transcript);
  assert.equal(reader.readSessionMessages('kiro', { sessionId }, { ...options,
    accountRef: 'acct_abcdef1234567890abcd' }).length, 0);
  const saved = transcript + '.saved';
  fs.renameSync(transcript, saved);
  fs.symlinkSync(saved, transcript);
  assert.equal(reader.readSessionMessages('kiro', { sessionId }, options).length, 0);
  assert.equal(reader.readProjectsFromHostByProviders(['kiro'], options).length, 0);
});
