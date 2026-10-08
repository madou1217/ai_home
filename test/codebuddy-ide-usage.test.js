'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { credential } = require('./helpers/codebuddy-credential');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { readIdeRequestUsage } = require('../lib/usage/codebuddy-ide-usage-scanner');
const { discoverCodebuddyIdeSessions } = require('../lib/sessions/codebuddy-ide-store');
const { createCodebuddyUsageRefresh } = require('../lib/usage/codebuddy-usage-refresh');
const { readProjectsFromHostByProviders, readSessionMessages, resolveSessionFilePath } = require('../lib/sessions/session-reader');
const { buildResumeCommand } = require('../lib/server/native-session-chat-command');

const AT = 1_791_000_000_000;
const PROJECT = 'a'.repeat(32), SESSION = 'b'.repeat(32), USER = 'c'.repeat(32);
const ASSISTANT = 'd'.repeat(32), REQUEST = 'e'.repeat(32);
const BILL = { inputTokens: 100, outputTokens: 20, totalTokens: 120,
  cacheTokens: 30, cachedWriteTokens: 10, credit: 9.99 };

function harness(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ide-usage-')));
  const aiHomeDir = path.join(root, 'aih'), hostHomeDir = path.join(root, 'host');
  fs.mkdirSync(hostHomeDir);
  const service = createModelUsageService({ fs, path, aiHomeDir, hostHomeDir, enableAsyncQueries: false });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function source(uid = 'native-user', alias = '1') {
    const accountRef = upsertAccountRef(fs, aiHomeDir, { provider: 'codebuddy', cliAccountId: alias, identitySeed: `${uid}:${alias}` });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential('codebuddy', { uid }) });
    const home = resolveAccountRuntimeDir(aiHomeDir, 'codebuddy', accountRef);
    const project = path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', uid, 'CodeBuddyIDE', uid, 'history', PROJECT);
    const session = path.join(project, SESSION);
    fs.mkdirSync(path.join(session, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(home, 'electron-user-data'), { recursive: true });
    const db = new DatabaseSync(path.join(home, 'electron-user-data', 'codebuddy-sessions.vscdb'));
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(`session:${SESSION}`, JSON.stringify({
      conversationId: SESSION, userId: uid, cwd: '/workspace/project', title: 'Native title', createdAt: AT - 10, updatedAt: AT + 20
    }));
    db.close();
    fs.writeFileSync(path.join(project, 'index.json'), JSON.stringify({ conversations: [{ id: SESSION, name: 'Old title', lastMessageAt: new Date(AT).toISOString() }] }));
    function write(overrides = {}) {
      fs.writeFileSync(path.join(session, 'index.json'), JSON.stringify({
        messages: [{ id: USER, role: 'user', isComplete: true }, { id: ASSISTANT, role: 'assistant', isComplete: false }],
        requests: [{ id: REQUEST, messages: [USER, ASSISTANT], state: 'complete', startedAt: AT, usage: BILL, ...overrides }]
      }));
      fs.writeFileSync(path.join(session, 'messages', `${USER}.json`), JSON.stringify({ id: USER, role: 'user', message: 'Hello', createdAt: new Date(AT).toISOString(), extra: '{}' }));
      fs.writeFileSync(path.join(session, 'messages', `${ASSISTANT}.json`), JSON.stringify({ id: ASSISTANT, role: 'assistant', message: 'Hello back', createdAt: new Date(AT + 10).toISOString(), extra: JSON.stringify({ modelId: 'default-model' }) }));
    }
    write();
    return { accountRef, home, project, session, write };
  }
  function rows() {
    const store = openModelUsageStore({ fs, path, aiHomeDir });
    try { return store.db.prepare("SELECT * FROM model_usage_records WHERE source_kind='desktop_history'").all(); }
    finally { store.close(); }
  }
  return { root, aiHomeDir, hostHomeDir, service, source, rows };
}

test('CodeBuddy IDE request billing uses native totals, attributes the exact account, and deduplicates rescans', t => {
  const h = harness(t), s = h.source();
  const scanned = h.service.scan({ provider: 'codebuddy' });
  assert.equal(scanned.records, 1);
  assert.equal(scanned.providers.codebuddy.records, 1);
  assert.equal(scanned.prompts, 1);
  const [row] = h.rows();
  assert.equal(row.account_ref, s.accountRef);
  assert.equal(row.input_tokens, 60);
  assert.equal(row.cache_read_input_tokens, 30);
  assert.equal(row.cache_creation_input_tokens, 10);
  assert.equal(row.output_tokens, 20);
  assert.equal(row.total_tokens, 120);
  assert.notEqual(row.cost_usd, 9.99, 'credits are not dollars');
  assert.equal(h.service.getAccountTokenUsage({ nowMs: AT + 1000 })[s.accountRef].total, 120);
  assert.equal(h.service.scan({ provider: 'workbuddy' }).records, 0, 'same-region reader cannot charge IDE bills twice');
  assert.equal(h.rows().length, 1);
});

test('incomplete native requests and late message files wait for a complete bill rather than inventing token usage', t => {
  const h = harness(t), s = h.source();
  s.write({ state: 'running' });
  assert.equal(h.service.scan({ provider: 'codebuddy' }).records, 0);
  s.write();
  const message = path.join(s.session, 'messages', `${ASSISTANT}.json`);
  fs.renameSync(message, message + '.pending');
  assert.equal(h.service.scan({ provider: 'codebuddy' }).records, 0);
  fs.renameSync(message + '.pending', message);
  assert.equal(h.service.scan({ provider: 'codebuddy' }).records, 1);
  assert.equal(h.rows()[0].total_tokens, 120);
  assert.equal(readIdeRequestUsage({ id: REQUEST, state: 'complete', usage: { ...BILL, totalTokens: 121 } }), null);
});

test('conflicting copies stay unattributed and an established bill is not moved to the later importer', t => {
  const h = harness(t), first = h.source('first');
  h.source('second', '2');
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].account_ref, '');
  const store = openModelUsageStore({ fs, path, aiHomeDir: h.aiHomeDir });
  store.db.prepare('UPDATE model_usage_records SET account_ref=? WHERE source_kind=?').run(first.accountRef, 'desktop_history');
  store.close();
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows()[0].account_ref, first.accountRef);
});

test('IDE identity mismatch and symlinked account or message stores cannot borrow another owner', t => {
  const h = harness(t), s = h.source();
  const db = new DatabaseSync(path.join(s.home, 'electron-user-data', 'codebuddy-sessions.vscdb'));
  db.prepare('UPDATE ItemTable SET value=?').run(JSON.stringify({ conversationId: SESSION, userId: 'other' }));
  db.close();
  assert.equal(discoverCodebuddyIdeSessions({ fs, path, aiHomeDir: h.aiHomeDir, hostHomeDir: h.hostHomeDir }).length, 0);
  const backup = s.home + '-old';
  fs.renameSync(s.home, backup);
  fs.symlinkSync(backup, s.home, 'dir');
  assert.equal(h.service.scan({ provider: 'codebuddy' }).records, 0);
});

test('a real existing IDE index update automatically refreshes account tokens without a WebUI request', async t => {
  const h = harness(t), s = h.source();
  s.write({ state: 'running' });
  const updates = [];
  const refresh = createCodebuddyUsageRefresh({ fs, path, aiHomeDir: h.aiHomeDir, hostHomeDir: h.hostHomeDir,
    modelUsageService: h.service, onTokenUsageUpdated: (usage, options) => updates.push({ usage, options }) });
  t.after(() => refresh.stop());
  refresh.start();
  s.write();
  const deadline = Date.now() + 5000;
  while (!updates.some(update => update.usage[s.accountRef]?.total === 120) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(updates.find(update => update.options.provider === 'codebuddy')?.usage[s.accountRef]?.total, 120);
  assert.equal(h.rows().length, 1);
});

test('IDE native titles, activity and message envelopes appear in both regional product histories and refresh independently of index writes', t => {
  const h = harness(t), s = h.source();
  const options = { hostHomeDir: h.hostHomeDir, aiHomeDir: h.aiHomeDir };
  const assistantPath = path.join(s.session, 'messages', `${ASSISTANT}.json`);
  const userPath = path.join(s.session, 'messages', `${USER}.json`);
  const user = JSON.parse(fs.readFileSync(userPath));
  user.message = JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<project_guidance>Private context</project_guidance><user_query>Native question</user_query>' }] });
  user.extra = JSON.stringify({ sourceContentBlocks: [{ type: 'text', text: 'Native question' }] });
  fs.writeFileSync(userPath, JSON.stringify(user));
  const answer = JSON.parse(fs.readFileSync(assistantPath));
  answer.message = JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Native answer' }] });
  fs.writeFileSync(assistantPath, JSON.stringify(answer));
  for (const provider of ['codebuddy', 'workbuddy']) {
    const projects = readProjectsFromHostByProviders([provider], options);
    const session = projects.flatMap(project => project.sessions).find(session => session.id === SESSION);
    assert.ok(session);
    assert.equal(session.title, 'Native title');
    assert.equal(session.updatedAt, AT + 20);
    assert.equal(resolveSessionFilePath(provider, { sessionId: SESSION }, options), path.join(s.session, 'index.json'));
    const messages = readSessionMessages(provider, { sessionId: SESSION }, options);
    assert.equal(messages[0].content, 'Native question');
    assert.equal(messages[1].content, 'Native answer');
    assert.equal(messages[1].model, 'default-model');
  }
  assert.equal(readProjectsFromHostByProviders(['workbuddycn'], options).flatMap(project => project.sessions).length, 0);
  answer.message = JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Updated native answer' }] });
  fs.writeFileSync(assistantPath, JSON.stringify(answer));
  assert.equal(readSessionMessages('codebuddy', { sessionId: SESSION }, options)[1].content, 'Updated native answer');
  assert.throws(() => buildResumeCommand('codebuddy', { ...options, sessionId: SESSION, prompt: 'Continue' }),
    error => error.code === 'native_session_resume_unsupported' && error.message.includes('Desktop'));
});

test('a CLI transcript with a 32-character ID still resumes through the official CLI', t => {
  const h = harness(t);
  h.source();
  const project = path.join(h.hostHomeDir, '.codebuddy', 'projects', 'cli-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), '{}\n');
  for (const provider of ['codebuddy', 'workbuddy']) {
    const command = buildResumeCommand(provider, { hostHomeDir: h.hostHomeDir, aiHomeDir: h.aiHomeDir,
      sessionId: SESSION, prompt: 'Continue' });
    assert.ok(command.args.includes('--resume'));
    assert.ok(command.args.includes(SESSION));
  }
});

test('a symlinked IDE index cannot introduce foreign billing or conversations', t => {
  const h = harness(t), s = h.source();
  const index = path.join(s.session, 'index.json');
  fs.renameSync(index, index + '.foreign');
  fs.symlinkSync(index + '.foreign', index);
  assert.equal(h.service.scan({ provider: 'codebuddy' }).records, 0);
  assert.equal(readSessionMessages('codebuddy', { sessionId: SESSION }, {
    hostHomeDir: h.hostHomeDir, aiHomeDir: h.aiHomeDir
  }).length, 0);
});

for (const [platform, parts] of [['win32', ['AppData', 'Local']], ['linux', ['.local', 'share']]]) {
  test(`IDE history follows the official ${platform} FilePathService root`, t => {
    const h = harness(t), s = h.source();
    const original = path.join(s.home, 'Library', 'Application Support', 'CodeBuddyExtension');
    const destination = path.join(s.home, ...parts, 'CodeBuddyExtension');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(original, destination);
    const sessions = discoverCodebuddyIdeSessions({ fs, path, aiHomeDir: h.aiHomeDir, hostHomeDir: h.hostHomeDir, platform });
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0].indexPath.startsWith(destination + path.sep));
  });
}
