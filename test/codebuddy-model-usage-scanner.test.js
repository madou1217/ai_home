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
const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { readCodebuddyUsage, discoverCodebuddyUsageFiles } = require('../lib/usage/codebuddy-model-usage-scanner');
const { resolveAccountCliRuntimeDir } = require('../lib/runtime/aih-storage-layout');

const AT = 1_790_000_000_000;
const SESSION_ID = 'shared-session';
const DIRS = { codebuddy: '.codebuddy', codebuddycn: '.codebuddy-cn', workbuddy: '.workbuddy-ai', workbuddycn: '.workbuddy' };

function createHarness(t, provider = 'workbuddy') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-usage-'));
  const hostHomeDir = path.join(root, 'host');
  const aiHomeDir = path.join(root, 'aih');
  const projectsRoot = path.join(hostHomeDir, DIRS[provider], 'projects');
  const file = path.join(projectsRoot, 'project', `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const service = createModelUsageService({ fs, path, hostHomeDir, aiHomeDir, enableAsyncQueries: false });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function account(providerId = provider, uid = 'native-user', alias = '1') {
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider: providerId, cliAccountId: alias, identitySeed: `${providerId}:${uid}:${alias}`
    });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential(providerId, { uid }) });
    return accountRef;
  }
  function metadata(uid) {
    const db = new DatabaseSync(path.join(path.dirname(projectsRoot), 'workbuddy.db'));
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT)');
    db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(SESSION_ID, uid);
    db.close();
  }
  function rows() {
    const store = openModelUsageStore({ fs, path, aiHomeDir });
    try { return store.db.prepare('SELECT * FROM model_usage_records WHERE source_kind = ? ORDER BY timestamp_ms').all('session_jsonl'); }
    finally { store.close(); }
  }
  return { root, hostHomeDir, aiHomeDir, projectsRoot, file, provider, service, account, metadata, rows };
}

function message(id, at = AT, overrides = {}) {
  return { id, timestamp: at, type: 'message', role: 'assistant', sessionId: SESSION_ID,
    cwd: '/workspace/project', providerData: { model: 'glm-5.2', conversationRequestId: `request-${id}`,
      rawUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 },
        cache_creation_input_tokens: 10, credit: 9.99 } }, ...overrides };
}

function write(file, entries) {
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function writerLog(h, provider, accountRef, entries) {
  const root = resolveAccountCliRuntimeDir(h.aiHomeDir, provider, accountRef);
  const file = path.join(root, DIRS[provider], 'logs', '2026-10-07', 'project.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = entries.map(({ id, timestamp }) => {
    const date = new Date(timestamp);
    const at = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
    return `[${at}] [Info] [pid=42] [addHistory] START sessionId=${SESSION_ID}, storeId=undefined, types=[message], input=[{type: message, id: ${id}}]`;
  });
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

test('CLI and desktop writer evidence attributes each shared-session bill to its actual account and product', (t) => {
  const h = createHarness(t, 'codebuddy');
  const first = h.account('codebuddy', 'first');
  const second = h.account('workbuddy', 'second');
  const old = message('old', AT - 60_000), a = message('first', AT), b = message('second', AT + 10_000);
  write(h.file, [old, a, b]);
  writerLog(h, 'codebuddy', first, [a]);
  writerLog(h, 'workbuddy', second, [b, { ...old, timestamp: AT + 20_000 }]);
  h.service.scan({ providers: ['codebuddy', 'workbuddy'] });
  assert.deepEqual(h.rows().map((row) => [row.provider, row.account_ref]), [
    ['codebuddy', ''], ['codebuddy', first], ['workbuddy', second]
  ]);
  const totals = h.service.getAccountTokenUsage({ nowMs: AT + 30_000 });
  assert.equal(totals[first].total, 120);
  assert.equal(totals[second].total, 120);
});

test('late private logs reconcile the same bill without JSONL changes and preserve its established owner', (t) => {
  const h = createHarness(t, 'codebuddy');
  const first = h.account('codebuddy', 'first');
  const second = h.account('workbuddy', 'second');
  const entry = message('answer');
  write(h.file, [entry]);
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows()[0].account_ref, '');
  const stat = fs.statSync(h.file);
  writerLog(h, 'workbuddy', second, [entry]);
  assert.equal(h.service.scan({ provider: 'codebuddy' }).records, 1);
  assert.equal(fs.statSync(h.file).mtimeMs, stat.mtimeMs);
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].account_ref, second);
  writerLog(h, 'codebuddy', first, [entry]);
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].account_ref, second, 'later conflicting/imported logs cannot move an already attributed bill');
});

test('ambiguous native writer evidence cannot fall back to the currently selected desktop account', (t) => {
  const h = createHarness(t, 'codebuddy');
  const first = h.account('codebuddy', 'first'), second = h.account('workbuddy', 'second');
  const entry = message('answer');
  h.metadata('first');
  write(h.file, [entry]);
  writerLog(h, 'codebuddy', first, [entry]);
  writerLog(h, 'workbuddy', second, [entry]);
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows()[0].account_ref, '');
});

test('a late message writer cannot be replaced by the current shared-session user', (t) => {
  const h = createHarness(t, 'codebuddy');
  const first = h.account('codebuddy', 'first'), second = h.account('workbuddy', 'second');
  const previous = message('previous'), next = message('next', AT + 10_000);
  h.metadata('first');
  write(h.file, [previous, next]);
  writerLog(h, 'codebuddy', first, [previous]);
  h.service.scan({ provider: 'codebuddy' });
  assert.deepEqual(h.rows().map(row => row.account_ref), [first, '']);
  writerLog(h, 'workbuddy', second, [next]);
  h.service.scan({ provider: 'codebuddy' });
  assert.deepEqual(h.rows().map(row => row.account_ref), [first, second]);
  assert.equal(h.rows().length, 2);
  assert.equal(h.service.getAccountTokenUsage({ nowMs: AT + 30_000 })[second].total, 120);
});

test('family usage scanner reads native billed tokens, keeps cache/reasoning separate, and never treats credits as dollars', (t) => {
  const h = createHarness(t);
  const ref = h.account();
  h.metadata('native-user');
  write(h.file, [{ id: 'prompt', type: 'message', role: 'user', timestamp: AT - 10, sessionId: SESSION_ID }, message('answer')]);
  const scanned = h.service.scan({ provider: 'workbuddy' });
  assert.equal(scanned.records, 1);
  assert.equal(scanned.prompts, 1);
  const [row] = h.rows();
  assert.equal(row.account_ref, ref);
  assert.equal(row.provider, 'workbuddy');
  assert.equal(row.input_tokens, 60);
  assert.equal(row.output_tokens, 15);
  assert.equal(row.cache_read_input_tokens, 30);
  assert.equal(row.cache_creation_input_tokens, 10);
  assert.equal(row.reasoning_output_tokens, 5);
  assert.equal(row.total_tokens, 120);
  assert.notEqual(row.cost_usd, 9.99);
  assert.equal(h.service.getAccountTokenUsage({ nowMs: AT + 1000 })[ref].total, 120);
  assert.equal(h.service.scan({ provider: 'workbuddy' }).records, 0);
  assert.equal(h.rows().length, 1);
  assert.equal(h.service.getSessions({ provider: 'workbuddy' })[0].promptCount, 1);
});

test('matching native user IDs determine ownership; multiple accounts never cause default-account attribution', (t) => {
  const h = createHarness(t, 'workbuddycn');
  h.account('workbuddycn', 'user-one');
  const second = h.account('workbuddycn', 'user-two', '2');
  h.metadata('user-two');
  write(h.file, [message('answer')]);
  h.service.scan({ provider: 'workbuddycn' });
  assert.equal(h.rows()[0].account_ref, second);
  h.metadata('unknown-user');
  fs.appendFileSync(h.file, JSON.stringify(message('unattributed', AT + 20)) + '\n');
  h.service.scan({ provider: 'workbuddycn' });
  assert.equal(h.rows()[0].account_ref, second);
  assert.equal(h.rows()[1].account_ref, '');
});

test('same-identity ambiguous accounts and CLI files without identity remain unattributed', (t) => {
  const h = createHarness(t);
  h.account();
  h.account('workbuddy', 'native-user', '2');
  h.metadata('native-user');
  write(h.file, [message('answer')]);
  h.service.scan({ provider: 'workbuddy' });
  assert.equal(h.rows()[0].account_ref, '');
  assert.equal(Object.keys(h.service.getAccountTokenUsage()).length, 0);
});

test('explicit completed-turn scopes attribute only that turn and preserve prior accounts across native resumes', (t) => {
  const h = createHarness(t, 'codebuddy');
  const first = h.account('codebuddy', 'first');
  const second = h.account('codebuddy', 'second', '2');
  write(h.file, [message('old', AT - 1000), message('first', AT)]);
  h.service.scanCodebuddySessionUsage('codebuddy', SESSION_ID, {
    provider: 'codebuddy', accountRef: first, startedAtMs: AT - 10, completedAtMs: AT + 10
  });
  fs.appendFileSync(h.file, JSON.stringify(message('second', AT + 1000)) + '\n');
  h.service.scanCodebuddySessionUsage('codebuddy', SESSION_ID, {
    provider: 'codebuddy', accountRef: second, startedAtMs: AT + 990, completedAtMs: AT + 1010
  });
  assert.deepEqual(h.rows().map((row) => row.account_ref), ['', first, second]);
  h.service.scan({ provider: 'codebuddy' });
  assert.deepEqual(h.rows().map((row) => row.account_ref), ['', first, second]);
});

test('native late identity reconciles unassigned usage without adding another bill', (t) => {
  const h = createHarness(t);
  const ref = h.account();
  write(h.file, [message('answer')]);
  h.service.scan({ provider: 'workbuddy' });
  assert.equal(h.rows()[0].account_ref, '');
  h.metadata('native-user');
  h.service.scan({ provider: 'workbuddy' });
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].account_ref, ref);
});

test('regional shared roots and copied transcripts count each native message once', (t) => {
  const h = createHarness(t, 'codebuddy');
  const shared = path.join(h.hostHomeDir, '.workbuddy-ai', 'projects', 'project', `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  write(h.file, [message('answer')]);
  fs.copyFileSync(h.file, shared);
  h.service.scan({ providers: ['codebuddy', 'workbuddy'] });
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].total_tokens, 120);
});

test('legacy family model hints never count as calls or mask the actual billed model', (t) => {
  const h = createHarness(t);
  const ref = h.account();
  write(h.file, [message('answer')]);
  h.service.scanCodebuddySessionUsage('workbuddy', SESSION_ID, {
    provider: 'workbuddy', accountRef: ref, startedAtMs: AT - 10, completedAtMs: AT + 10
  });
  h.service.recordUsage({ eventKey: 'workbuddy:legacy-native-hint', provider: 'workbuddy',
    accountRef: ref, sessionId: SESSION_ID, sourceKind: 'native_session_done',
    model: 'auto', timestampMs: AT + 100 });
  const query = { provider: 'workbuddy', fromMs: AT - 1000, toMs: AT + 1000 };
  assert.equal(h.service.getLastSessionModel('workbuddy', SESSION_ID), 'glm-5.2');
  assert.deepEqual(h.service.getCostByModel(query).map(row => [row.model, row.calls, row.totalTokens]), [['glm-5.2', 1, 120]]);
  assert.equal(h.service.getSessions(query)[0].calls, 1);
  const store = openModelUsageStore({ fs, path, aiHomeDir: h.aiHomeDir });
  try {
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM model_usage_records WHERE source_kind = 'native_session_done'").get().count, 1,
      'read projection must preserve raw historical evidence');
  } finally { store.close(); }
  h.service.recordUsage({ eventKey: 'agy:model-hint', provider: 'agy', sessionId: 'agy-session',
    sourceKind: 'native_session_done', model: 'gemini-native', timestampMs: AT });
  assert.equal(h.service.getLastSessionModel('agy', 'agy-session'), 'gemini-native', 'unbilled native providers retain their model timeline');
});

test('international and domestic files never deduplicate or inherit ownership across regions', (t) => {
  const h = createHarness(t, 'codebuddy');
  const ref = h.account();
  const domestic = path.join(h.hostHomeDir, '.workbuddy', 'projects', 'project', `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(domestic), { recursive: true });
  write(h.file, [message('answer')]);
  write(domestic, [message('answer')]);
  h.service.scanCodebuddySessionUsage('workbuddycn', SESSION_ID, {
    provider: 'codebuddy', accountRef: ref, startedAtMs: AT - 10, completedAtMs: AT + 10
  });
  h.service.scan({ providers: ['codebuddy', 'workbuddycn'] });
  assert.equal(h.rows().length, 2);
  assert.deepEqual(h.rows().map((row) => row.account_ref), ['', '']);
});

test('unfinished JSONL is reread and amended usage replaces the same message bill', (t) => {
  const h = createHarness(t, 'codebuddy');
  const complete = JSON.stringify(message('answer'));
  fs.writeFileSync(h.file, complete.slice(0, 40));
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows().length, 0);
  fs.appendFileSync(h.file, complete.slice(40) + '\n');
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows().length, 1);
  const amended = message('answer');
  amended.providerData.rawUsage.completion_tokens = 25;
  fs.appendFileSync(h.file, JSON.stringify(amended) + '\n');
  h.service.scan({ provider: 'codebuddy' });
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].total_tokens, 125);
});

test('usage normalization supports actual native fallback formats and ignores context-only records', () => {
  assert.equal(readCodebuddyUsage({ type: 'summary', usage: { totalTokens: 99999 } }), null);
  assert.equal(readCodebuddyUsage({ type: 'message', role: 'user', providerData: message('x').providerData }), null);
  assert.deepEqual(readCodebuddyUsage(message('x', AT, { providerData: { usage: {
    inputTokens: 100, outputTokens: 20, inputTokensDetails: [{ cached_tokens: 30 }],
    outputTokensDetails: [{ reasoning_tokens: 5 }]
  } } })), { inputTokens: 70, outputTokens: 15, cacheReadInputTokens: 30,
    cacheCreationInputTokens: 0, reasoningOutputTokens: 5, totalTokens: 120 });
});

test('targeted discovery rejects traversal and does not scan other sessions', (t) => {
  const h = createHarness(t);
  write(h.file, [message('answer')]);
  write(path.join(path.dirname(h.file), 'other-session.jsonl'), [message('other')]);
  const discover = (sessionId) => discoverCodebuddyUsageFiles({ fs, path,
    hostHomeDir: h.hostHomeDir, providers: ['workbuddy'], sessionId });
  assert.equal(discover(SESSION_ID).length, 1);
  assert.deepEqual(discover('../shared-session'), []);
  assert.throws(() => h.service.scanCodebuddySessionUsage('workbuddy', '../shared-session'), /session_invalid/);
});

test('the family persistence adapter rejects API or non-family records without changing existing bills', (t) => {
  const h = createHarness(t);
  write(h.file, [message('answer')]);
  h.service.scan({ provider: 'workbuddy' });
  const store = openModelUsageStore({ fs, path, aiHomeDir: h.aiHomeDir });
  try {
    const record = { eventKey: h.rows()[0].event_key, provider: 'codex', sourceKind: 'session_jsonl',
      model: 'gpt-6-astra', timestampMs: AT, inputTokens: 999 };
    assert.throws(() => store.reconcileCodebuddyUsageBatch([record]), /projection_scope_invalid/);
    assert.equal(h.rows()[0].total_tokens, 120);
  } finally { store.close(); }
});
