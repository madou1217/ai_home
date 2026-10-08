'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { credential } = require('./helpers/codebuddy-credential');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { EXTENSION_ID, prepareCodebuddyIdeBridge } = require('../lib/runtime/codebuddy-ide-bridge');
const { createCodebuddyIdeCommandBridge } = require('../lib/runtime/codebuddy-ide-bridge-extension.cjs');
const { readPrivateJson, writePrivateJson } = require('../lib/runtime/codebuddy-ide-bridge-files');
const { spawnCodebuddyIdeSessionStream } = require('../lib/server/codebuddy-ide-session-runner');
const { spawnNativeSessionStream, buildResumeCommand } = require('../lib/server/native-session-chat');
const { readSessionMessages } = require('../lib/sessions/session-reader');

const PROJECT = 'a'.repeat(32), SESSION = 'b'.repeat(32), INITIAL = 'c'.repeat(32);
const PREFIX = 'tencentcloud.codingcopilot.';
const nativeId = () => crypto.randomUUID().replace(/-/g, '');

function harness(t, provider = 'codebuddy') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ide-bridge-')));
  const aiHomeDir = path.join(root, 'aih'), hostHomeDir = path.join(root, 'host');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(hostHomeDir);
  fs.mkdirSync(cwd);
  const accountRef = upsertAccountRef(fs, aiHomeDir, { provider, cliAccountId: '1', identitySeed: 'bridge-native-user' });
  const uid = 'bridge-native-user';
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential(provider, { uid }) });
  const profileDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  const parts = process.platform === 'darwin' ? ['Library', 'Application Support']
    : process.platform === 'win32' ? ['AppData', 'Local'] : ['.local', 'share'];
  const historyRoot = path.join(profileDir, ...parts, 'CodeBuddyExtension', 'Data', uid, 'CodeBuddyIDE', uid, 'history');
  const projectDir = path.join(historyRoot, PROJECT), sessionDir = path.join(projectDir, SESSION);
  fs.mkdirSync(path.join(sessionDir, 'messages'), { recursive: true });
  const projectIndexFile = path.join(projectDir, 'index.json');
  writePrivateJson(projectIndexFile, { conversations: [{ id: SESSION, name: 'Original IDE conversation',
    selectedModelId: 'default-model', createdAt: new Date().toISOString() }] });
  const indexFile = path.join(sessionDir, 'index.json');
  writePrivateJson(indexFile, { messages: [{ id: INITIAL, role: 'user', isComplete: true }], requests: [] });
  writePrivateJson(path.join(sessionDir, 'messages', `${INITIAL}.json`), {
    id: INITIAL, role: 'user', message: 'Earlier question', extra: '{}', createdAt: new Date().toISOString()
  });
  fs.mkdirSync(path.join(profileDir, 'electron-user-data'), { recursive: true });
  const db = new DatabaseSync(path.join(profileDir, 'electron-user-data', 'codebuddy-sessions.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(`session:${SESSION}`, JSON.stringify({
    conversationId: SESSION, userId: uid, cwd, title: 'Original IDE conversation', updatedAt: Date.now()
  }));
  db.close();
  const bundlePath = path.join(root, 'Official IDE.app');
  const productFile = path.join(bundlePath, 'Contents', 'Resources', 'app', 'product.json');
  fs.mkdirSync(path.dirname(productFile), { recursive: true });
  const dataFolderName = provider === 'codebuddy' ? '.codebuddy' : '.codebuddycn';
  writePrivateJson(productFile, { dataFolderName });
  const options = { provider, accountRef, aiHomeDir, hostHomeDir, profileDir, bundlePath,
    sessionId: SESSION, projectDirName: `ide-${PROJECT}`, prompt: 'Continue the original IDE conversation',
    model: 'auto', getProfileDir: () => profileDir, ensureSessionStoreLinks: () => ({ ok: true }) };
  const prepared = prepareCodebuddyIdeBridge(options);
  const calls = [], events = [];
  let context = { authenticated: true, userId: uid }, busy = false, responder;
  function append(prompt, answer = 'Official IDE reply') {
    const user = nativeId(), assistant = nativeId();
    for (const [id, role, text] of [[user, 'user', prompt], [assistant, 'assistant', answer]]) {
      writePrivateJson(path.join(sessionDir, 'messages', `${id}.json`), { id, role,
        message: JSON.stringify({ role, content: [{ type: 'text', text }] }),
        extra: JSON.stringify({ modelId: 'default-model' }), createdAt: new Date().toISOString() });
    }
    const index = readPrivateJson(indexFile);
    index.messages.push({ id: user, role: 'user', isComplete: true }, { id: assistant, role: 'assistant', isComplete: false });
    index.requests.push({ id: nativeId(), state: 'complete', messages: [user, assistant], startedAt: Date.now() });
    writePrivateJson(indexFile, index);
  }
  async function executeCommand(command, payload) {
    calls.push({ command, payload });
    if (command === `${PREFIX}getContext`) return context;
    if (command === `${PREFIX}isAgentBusy`) return { busy };
    if (command === `${PREFIX}chat.sendMessage`) {
      if (responder) return responder(payload);
      append(payload.message);
      return { id: SESSION, completion: { success: true, state: 'completed', conversationId: SESSION } };
    }
    throw new Error('unexpected command');
  }
  const bridge = createCodebuddyIdeCommandBridge({ binding: prepared.binding, executeCommand,
    workspacePaths: () => [cwd] });
  t.after(() => { bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const result = runId => readPrivateJson(path.join(prepared.binding.mailboxDir, 'results', `${runId}.json`));
  async function waitForResult(runId) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const row = result(runId);
      if (row?.error || row?.state === 'settled') return row;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('bridge command did not settle');
  }
  function runner(overrides = {}) {
    return spawnCodebuddyIdeSessionStream({ ...options, onEvent: event => events.push(event), ...overrides });
  }
  return { root, cwd, profileDir, dataFolderName, productFile, options, prepared, bridge, calls, events,
    indexFile, projectIndexFile, sessionDir, append, runner, result, waitForResult,
    setContext: value => { context = value; }, setBusy: value => { busy = value; },
    setResponder: value => { responder = value; } };
}

for (const provider of ['codebuddy', 'codebuddycn']) {
  test(`${provider} installs only its account-private standard extension using the actual IDE product directory`, t => {
    const h = harness(t, provider);
    const productBefore = fs.readFileSync(h.productFile);
    const manifestFile = path.join(h.profileDir, h.dataFolderName, 'extensions', 'extensions.json');
    const existing = readPrivateJson(manifestFile);
    existing.unshift({ identifier: { id: 'another.user-extension' }, version: '1.0.0' });
    writePrivateJson(manifestFile, existing);
    const second = prepareCodebuddyIdeBridge(h.options);
    assert.equal(second.extensionPath, h.prepared.extensionPath);
    const rows = readPrivateJson(manifestFile);
    assert.equal(rows.filter(row => row.identifier.id === EXTENSION_ID).length, 1);
    assert.equal(rows[0].identifier.id, 'another.user-extension');
    assert.equal(rows.at(-1).location.fsPath, second.extensionPath);
    assert.deepEqual(fs.readFileSync(h.productFile), productBefore);
    assert.equal(readPrivateJson(path.join(second.extensionPath, 'package.json')).contributes, undefined,
      'a production extension must not leave the hardcoded verification command');
    assert.equal(fs.existsSync(path.join(h.options.hostHomeDir, h.dataFolderName)), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(second.binding.mailboxDir).mode & 0o077, 0);
    assert.equal(JSON.stringify(readPrivateJson(path.join(second.extensionPath, 'binding.json'))).includes('accessToken'), false);
  });
}

test('the production stream delegates an IDE exact resume before resolving or spawning any CLI', async t => {
  const h = harness(t);
  await h.bridge.heartbeat();
  const run = spawnNativeSessionStream({ ...h.options, interactiveCli: false,
    onEvent: event => h.events.push(event),
    resolveNativeCliLaunch() { assert.fail('an IDE transcript must not be given to a CLI'); }
  });
  assert.equal(run.child, null);
  await h.bridge.poll();
  const output = await run.done;
  assert.equal(output.sessionId, SESSION);
  assert.equal(output.content, 'Official IDE reply');
  const send = h.calls.find(call => call.command === `${PREFIX}chat.sendMessage`);
  assert.deepEqual(send.payload.options, { conversationId: SESSION, headless: false, prefillOnly: false,
    waitForCompletion: true, withSummary: false, timeout: 600000 });
  assert.equal(send.payload.message, h.options.prompt);
  assert.equal(h.events.filter(event => event.type === 'delta').map(event => event.delta).join(''), 'Official IDE reply');
  assert.equal(readSessionMessages('codebuddy', h.options, h.options).at(-1).content, 'Official IDE reply');
});

test('identity changes and native busy state reject before dispatch without retrying another account', async t => {
  for (const failure of ['identity', 'busy']) {
    const h = harness(t);
    await h.bridge.heartbeat();
    const run = h.runner();
    const rejected = assert.rejects(run.done, error => error.code === (failure === 'identity'
      ? 'codebuddy_ide_account_mismatch' : 'native_session_busy'));
    if (failure === 'identity') h.setContext({ authenticated: true, userId: 'other-user' });
    else h.setBusy(true);
    await h.bridge.poll();
    await rejected;
    assert.equal(h.calls.some(call => call.command.endsWith('chat.sendMessage')), false);
  }
});

test('explicit model changes fail before sending rather than silently using the Desktop selection', async t => {
  const h = harness(t);
  await h.bridge.heartbeat();
  const run = h.runner({ model: 'a-different-model' });
  const rejected = assert.rejects(run.done, error => error.code === 'codebuddy_ide_model_switch_required');
  await h.bridge.poll();
  await rejected;
  assert.equal(h.calls.some(call => call.command.endsWith('chat.sendMessage')), false);
});

test('native indexes larger than the mailbox limit remain resumable within the IDE store limit', async t => {
  const h = harness(t);
  for (const file of [h.indexFile, h.projectIndexFile]) {
    writePrivateJson(file, { ...readPrivateJson(file), metadata: 'x'.repeat(2 * 1024 * 1024) });
  }
  await h.bridge.heartbeat();
  const run = h.runner();
  h.setResponder(payload => {
    writePrivateJson(h.indexFile, { messages: [{ id: INITIAL, role: 'user', isComplete: true }], requests: [] });
    h.append(payload.message);
    return { id: SESSION, completion: { success: true, conversationId: SESSION } };
  });
  await h.bridge.poll();
  assert.equal((await run.done).content, 'Official IDE reply');
  assert.equal(h.calls.filter(call => call.command.endsWith('chat.sendMessage')).length, 1);
});

test('deleted exact targets fail without creating a replacement conversation', async t => {
  const h = harness(t);
  await h.bridge.heartbeat();
  const run = h.runner();
  const rejected = assert.rejects(run.done, error => error.code === 'codebuddy_ide_session_not_found');
  writePrivateJson(h.projectIndexFile, { conversations: [] });
  await h.bridge.poll();
  await rejected;
  assert.equal(h.calls.some(call => call.command.endsWith('chat.sendMessage')), false);
});

test('unsupported input and approval controls cannot be silently dropped', async t => {
  const h = harness(t);
  await h.bridge.heartbeat();
  for (const input of [{ imagePaths: ['/an/image.png'] }, { interactiveCli: true }, { terminalMode: true }]) {
    assert.throws(() => h.runner(input), error => error.code === 'codebuddy_ide_input_unsupported');
  }
  for (const approvalMode of ['confirm', 'plan']) {
    assert.throws(() => h.runner({ approvalMode }), error => error.code === 'codebuddy_ide_approval_bridge_unavailable');
  }
  assert.equal(fs.readdirSync(path.join(h.prepared.binding.mailboxDir, 'requests')).length, 0);
});

test('a running command is never replayed on polling, reload, or a duplicate accepted file; abort is honest', async t => {
  const h = harness(t);
  let complete;
  h.setResponder(payload => new Promise(resolve => { complete = () => {
    h.append(payload.message);
    resolve({ id: SESSION, completion: { success: true, conversationId: SESSION } });
  }; }));
  await h.bridge.heartbeat();
  const run = h.runner();
  await h.bridge.poll();
  const deadline = Date.now() + 2500;
  while (!complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(complete);
  assert.throws(() => run.abort(), error => error.code === 'codebuddy_ide_cancel_requires_desktop');
  const file = path.join(h.prepared.binding.mailboxDir, 'requests', `${run.runId}.json`);
  fs.copyFileSync(`${file}.accepted`, file);
  await h.bridge.poll();
  const reloaded = createCodebuddyIdeCommandBridge({ binding: h.prepared.binding,
    executeCommand() { assert.fail('reload must not dispatch an accepted request'); }, workspacePaths: () => [h.cwd] });
  await reloaded.poll();
  assert.equal(h.calls.filter(call => call.command.endsWith('chat.sendMessage')).length, 1);
  complete();
  await run.done;
  assert.doesNotThrow(() => run.abort());
});

test('an account-wide writer rejects concurrent requests from another server or IDE window', async t => {
  const h = harness(t);
  let complete;
  h.setResponder(payload => new Promise(resolve => { complete = () => {
    h.append(payload.message);
    resolve({ id: SESSION, completion: { success: true, conversationId: SESSION } });
  }; }));
  await h.bridge.heartbeat();
  const first = h.runner();
  await h.bridge.poll();
  const deadline = Date.now() + 2500;
  while (!complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const second = h.runner({ prompt: 'A concurrent request' });
  const rejected = assert.rejects(second.done, error => error.code === 'native_session_busy');
  await h.bridge.poll();
  await rejected;
  complete();
  await first.done;
  assert.equal(h.calls.filter(call => call.command.endsWith('chat.sendMessage')).length, 1);
});

test('foreign account readers, host-only copies, and foreign workspace hosts cannot borrow an IDE session', async t => {
  const h = harness(t);
  const other = upsertAccountRef(fs, h.options.aiHomeDir, { provider: 'codebuddy', cliAccountId: '2', identitySeed: 'another-account' });
  assert.equal(readSessionMessages('codebuddy', h.options, { ...h.options, accountRef: other }).length, 0);
  await h.bridge.heartbeat();
  const statusFile = path.join(h.prepared.binding.mailboxDir, 'hosts', `${process.pid}.json`);
  const status = readPrivateJson(statusFile);
  for (const changed of [{ userId: 'another-user' }, { accountRef: other }, { workspacePaths: [h.root] }]) {
    writePrivateJson(statusFile, { ...status, ...changed });
    assert.throws(() => h.runner(), error => error.code === 'codebuddy_ide_bridge_unavailable');
  }
  writePrivateJson(statusFile, status);
  const source = path.dirname(path.dirname(path.dirname(h.sessionDir)));
  const hostCopy = path.join(h.options.hostHomeDir, path.relative(h.profileDir, source));
  fs.mkdirSync(path.dirname(hostCopy), { recursive: true });
  fs.renameSync(source, hostCopy);
  assert.throws(() => h.runner(), error => error.code === 'codebuddy_ide_session_not_in_account');
});

test('IDE resume never falls through to a CLI even after its exact index disappears', t => {
  const h = harness(t);
  fs.unlinkSync(h.indexFile);
  assert.throws(() => spawnNativeSessionStream({ ...h.options,
    resolveNativeCliLaunch() { assert.fail('must not fall through to a CLI'); }
  }), error => error.code === 'codebuddy_ide_session_not_in_account');
  assert.throws(() => buildResumeCommand('workbuddy', h.options), error => error.code === 'native_session_resume_unsupported');
});

test('symlinked bridge state and malformed extension manifests fail without writing into their targets', t => {
  const h = harness(t);
  const mailbox = h.prepared.binding.mailboxDir;
  const saved = mailbox + '-saved';
  fs.renameSync(mailbox, saved);
  fs.symlinkSync(saved, mailbox, 'dir');
  assert.throws(() => prepareCodebuddyIdeBridge(h.options), error => error.code === 'codebuddy_ide_bridge_directory_not_private');
  fs.unlinkSync(mailbox);
  fs.renameSync(saved, mailbox);
  const manifest = path.join(h.prepared.extensionsDir, 'extensions.json');
  fs.writeFileSync(manifest, 'broken');
  assert.throws(() => prepareCodebuddyIdeBridge(h.options), error => error.code === 'codebuddy_ide_extension_manifest_invalid');
  assert.equal(fs.readFileSync(manifest, 'utf8'), 'broken');
});
