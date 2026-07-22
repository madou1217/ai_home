'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const sessionReader = require('../lib/sessions/session-reader');

test('Grok sessions are listed and restored from account-scoped storage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = 'acct_1234567890abcdef1234';
  const projectName = encodeURIComponent('C:\\work\\demo');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const sessionDir = path.join(root, 'run', 'auth-projections', 'grok', accountRef, '.grok', 'sessions', projectName, sessionId);
  fs.ensureDirSync(sessionDir);
  fs.writeJsonSync(path.join(sessionDir, 'summary.json'), {
    info: { session_id: sessionId },
    generated_title: 'Grok session',
    current_model_id: 'grok-code-fast-1',
    updated_at: '2026-07-22T12:00:00.000Z'
  });
  fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), [
    JSON.stringify({ role: 'user', content: 'hello' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'world' }], model: 'grok-code-fast-1' }),
    '{incomplete'
  ].join('\n'));

  const options = { aiHomeDir: root, accountRef, hostHomeDir: path.join(root, 'host') };
  const projects = sessionReader.readProjectsFromHostByProviders(['grok'], options);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, 'C:\\work\\demo');
  assert.equal(projects[0].sessions[0].id, sessionId);
  assert.equal(projects[0].sessions[0].accountRef, accountRef);

  const messages = sessionReader.readSessionMessages('grok', { sessionId, projectDirName: projectName }, options);
  assert.deepEqual(messages.map(({ role, content, model }) => ({ role, content, model })), [
    { role: 'user', content: 'hello', model: 'grok-code-fast-1' },
    { role: 'assistant', content: 'world', model: 'grok-code-fast-1' }
  ]);
  assert.equal(sessionReader.readSessionLastModel('grok', { sessionId, projectDirName: projectName }, options), 'grok-code-fast-1');
});
