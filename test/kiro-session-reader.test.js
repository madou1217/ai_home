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
