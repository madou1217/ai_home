'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProjectsFromHostByProviders, readSessionMessages } = require('../lib/sessions/session-reader');

function createQoderSession(provider = 'qodercn') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-reader-'));
  const hostHomeDir = path.join(aiHomeDir, 'host');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const accountRef = 'acct_63044849a0f6d3b8ee09';
  const projectDirName = 'C--work-ai-home';
  const sessionId = '329bf014-754f-460f-9285-54463f3e2cbb';
  const projectDir = path.join(aiHomeDir, 'run', 'auth-projections', provider, accountRef, 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'workspace-directories', directories: ['C:\\work\\ai-home'], sessionId }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-22T10:13:15.000Z', message: { role: 'user', content: 'hello' }, sessionId }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-22T10:13:27.000Z', message: { id: 'message-1', role: 'assistant', model: 'qmodel_preview', content: [{ type: 'thinking', thinking: 'brief thought' }] }, sessionId }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-22T10:13:27.100Z', message: { id: 'message-1', role: 'assistant', model: 'qmodel_preview', content: [{ type: 'text', text: 'Hello!' }] }, sessionId })
  ].join('\n'));
  return { aiHomeDir, hostHomeDir, accountRef, projectDirName, sessionId };
}

test('QoderCN sessions are discovered from the selected account projection', () => {
  const fixture = createQoderSession();
  const projects = readProjectsFromHostByProviders(['qodercn'], fixture);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, 'C:\\work\\ai-home');
  assert.equal(projects[0].sessions[0].id, fixture.sessionId);
  assert.equal(projects[0].sessions[0].title, 'hello');
});

test('QoderCN messages are read from the account-scoped transcript', () => {
  const fixture = createQoderSession();
  const messages = readSessionMessages('qodercn', {
    sessionId: fixture.sessionId,
    projectDirName: fixture.projectDirName
  }, fixture);
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(messages[1].thinking, 'brief thought');
  assert.equal(messages[1].content, 'Hello!');
});

test('QoderCN sessions fall back to the host store used by the native CLI', () => {
  const fixture = createQoderSession();
  const projectionPath = path.join(
    fixture.aiHomeDir,
    'run',
    'auth-projections',
    'qodercn',
    fixture.accountRef,
    'projects'
  );
  fs.rmSync(projectionPath, { recursive: true, force: true });
  const hostProjectDir = path.join(fixture.hostHomeDir, '.qoder-cn', 'projects', fixture.projectDirName);
  fs.mkdirSync(hostProjectDir, { recursive: true });
  fs.writeFileSync(path.join(hostProjectDir, `${fixture.sessionId}.jsonl`), [
    JSON.stringify({ type: 'workspace-directories', directories: ['C:\\work\\ai-home'] }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'host session' } })
  ].join('\n'));

  const projects = readProjectsFromHostByProviders(['qodercn'], fixture);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessions[0].id, fixture.sessionId);
  assert.equal(projects[0].sessions[0].accountRef, fixture.accountRef);
});
