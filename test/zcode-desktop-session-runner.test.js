'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { prepareZcodeDesktopBridge } = require('../lib/runtime/zcode-desktop-bridge-binding');
const { createZcodeDesktopProtocolBridge } = require('../lib/runtime/zcode-desktop-protocol-bridge');
const { readPrivateJson, writePrivateJson } = require('../lib/runtime/native-session-bridge-files');
const { spawnZcodeDesktopSessionStream } = require('../lib/server/zcode-desktop-session-runner');
const { spawnNativeSessionStream, runNativeSessionPrompt, ensureNativeCliReadyForChat } = require('../lib/server/native-session-chat');

const SESSION = 'sess_original';

function harness(t, { persistDelayMs = 0 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-session-')));
  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef = upsertAccountRef(fs, aiHomeDir, { provider: 'zcode', cliAccountId: '1', identitySeed: 'zcode:fixture-user' });
  const credentials = { 'oauth:zai:access_token': 'fixture', 'oauth:zai:user_info': JSON.stringify({ user_id: 'fixture-user' }) };
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials });
  const binding = prepareZcodeDesktopBridge({ aiHomeDir, accountRef });
  const credentialFile = path.join(binding.profileDir, '.zcode', 'v2', 'credentials.json');
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
  writePrivateJson(credentialFile, credentials);
  const dbFile = path.join(root, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, path TEXT,
    title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, sequence INTEGER, data TEXT);
    CREATE TABLE part (message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
    .run(SESSION, root, root, 'Original task', Date.now(), Date.now(), 'interactive');
  let sequence = 0;
  const append = (role, text) => {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, SESSION, Date.now(), sequence++, JSON.stringify({ role }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(id, SESSION, sequence, JSON.stringify({ type: 'text', text }));
  };
  append('user', 'Earlier prompt'); append('assistant', 'Earlier reply');
  const calls = [], protocol = new EventEmitter(), persistenceTimers = new Set();
  protocol.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session/resume') return { session: { sessionId: SESSION, workspace: { workspacePath: root }, status: 'idle',
      model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' } }, runtime: { stateRevision: 2 },
    settings: { mode: { current: 'yolo' } } };
    if (method === 'session/send') {
      const persist = () => { append('user', params.content); append('assistant', 'Official native reply'); };
      if (persistDelayMs) persistenceTimers.add(setTimeout(persist, persistDelayMs));
      else persist();
      protocol.emit('message', { method: 'state.updated', params: { sessionId: SESSION, reason: 'prompt_started', revision: 3 } });
      protocol.emit('message', { method: 'state.updated', params: { sessionId: SESSION, reason: 'prompt_completed', revision: 4 } });
      return { accepted: true, sessionId: SESSION, stateRevision: 3 };
    }
    return {};
  };
  const bridge = createZcodeDesktopProtocolBridge({ binding, protocol, cwd: root });
  bridge.start();
  protocol.emit('input', { id: 'desktop-config', method: 'provider/updateAccountConfig' });
  protocol.emit('message', { id: 'desktop-config', result: {} });
  protocol.emit('message', { id: 'desktop-resume', result: { session: { sessionId: SESSION, workspace: { workspacePath: root } } } });
  bridge.heartbeat();
  t.after(() => {
    for (const timer of persistenceTimers) clearTimeout(timer);
    bridge.dispose(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { aiHomeDir, hostHomeDir: root, provider: 'zcode', accountRef, sessionId: SESSION,
    projectPath: root, projectDirName: root, prompt: 'Continue my original task', model: 'GLM-5.3-Flash',
    getProfileDir: () => binding.profileDir, approvalMode: 'bypass' };
  return { root, binding, options, bridge, calls };
}

test('streaming resumes the exact native session and returns only the new stored assistant text', async t => {
  const h = harness(t), events = [];
  const run = spawnNativeSessionStream({ ...h.options, onEvent: event => events.push(event),
    resolveNativeCliLaunch() { assert.fail('a Desktop session must not spawn a separate CLI'); } });
  const result = await run.done;
  assert.equal(result.sessionId, SESSION);
  assert.equal(result.content, 'Official native reply');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.delta).join(''), result.content);
  assert.equal(h.calls.filter(call => call.method === 'session/send').length, 1);
});

test('completion waits for the native transcript to become readable without replaying the prompt', async t => {
  const h = harness(t, { persistDelayMs: 350 });
  const result = await spawnZcodeDesktopSessionStream(h.options).done;
  assert.equal(result.sessionId, SESSION);
  assert.equal(result.content, 'Official native reply');
  assert.equal(h.calls.filter(call => call.method === 'session/send').length, 1);
});

test('non-streaming requests share the same Desktop lifecycle without requesting a CLI terminal', async t => {
  const h = harness(t);
  assert.deepEqual(await ensureNativeCliReadyForChat('zcode'), { ok: true, installed: false });
  const result = await runNativeSessionPrompt(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, SESSION);
  assert.equal(result.content, 'Official native reply');
});

test('a foreign account, stale bridge version, missing session, or another workspace fails before mailbox dispatch', t => {
  const h = harness(t);
  assert.throws(() => spawnZcodeDesktopSessionStream({ ...h.options, accountRef: 'acct_ffffffffffffffffffff' }), { code: 'zcode_desktop_account_unavailable' });
  assert.throws(() => spawnZcodeDesktopSessionStream({ ...h.options, sessionId: 'sess_deleted' }), { code: 'zcode_desktop_session_not_found' });
  assert.throws(() => spawnZcodeDesktopSessionStream({ ...h.options, projectPath: path.dirname(h.root) }), { code: 'zcode_desktop_workspace_mismatch' });
  const hostFile = path.join(h.binding.mailboxDir, 'hosts', `${process.pid}.json`);
  const host = readPrivateJson(hostFile);
  for (const changed of [{ version: 'old' }, { identity: 'foreign' }, { accountRef: 'acct_ffffffffffffffffffff' }, { at: Date.now() - 20000 }]) {
    writePrivateJson(hostFile, { ...host, ...changed });
    assert.throws(() => spawnZcodeDesktopSessionStream(h.options), { code: 'zcode_desktop_bridge_unavailable' });
  }
  assert.equal(fs.readdirSync(path.join(h.binding.mailboxDir, 'requests')).length, 0);
});

test('new sessions, attachments, slash input and confirm approval cannot be silently dropped', t => {
  const h = harness(t);
  assert.throws(() => spawnZcodeDesktopSessionStream({ ...h.options, sessionId: '' }), { code: 'zcode_desktop_resume_required' });
  for (const input of [{ imagePaths: ['/an/image.png'] }, { interactiveCli: true }, { initialInput: '/model' }, { terminalMode: true }]) {
    assert.throws(() => spawnZcodeDesktopSessionStream({ ...h.options, ...input }), { code: 'zcode_desktop_input_unsupported' });
  }
  assert.throws(() => spawnZcodeDesktopSessionStream({ ...h.options, approvalMode: 'confirm' }), { code: 'zcode_desktop_approval_requires_desktop' });
  assert.equal(fs.readdirSync(path.join(h.binding.mailboxDir, 'requests')).length, 0);
});
