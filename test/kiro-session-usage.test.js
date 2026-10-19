const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  createKiroSessionLineParser,
  classifyKiroTurnStatus,
  scanKiroSessionFile,
  discoverKiroSessionFiles,
  KIRO_SESSION_USAGE_SOURCE_KIND
} = require('../lib/usage/kiro-session-usage');
const { createRegistryScopeOwnership } = require('../lib/usage/registry-scope-ownership');
const { createNativeSessionOutcomePoller } = require('../lib/server/native-session-outcome-poller');
const { createKiroTurnCollector } = require('../lib/server/kiro-session-outcomes');
const { __private: scanner } = require('../lib/usage/model-usage-scanner');

const ACCOUNT_A = 'acct_aaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acct_bbbbbbbbbbbbbbbbbbbb';
const T0 = Date.parse('2026-10-19T01:00:00.000Z');

function line(id, atMs, payload) {
  return `${JSON.stringify({ id, timestamp: new Date(atMs).toISOString(), payload })}\n`;
}

function ctx(id, atMs, pct) {
  return line(id, atMs, { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: pct }, executionId: 'e1' });
}

function createFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-usage-'));
  const cwd = '/work/project';
  const group = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const sessionDir = path.join(home, '.kiro', 'sessions', group, 'sess_test-1');
  fs.mkdirSync(path.join(sessionDir, 'sub-executions'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    id: 'sess_test-1', modelId: 'claude-opus-5.5', workspacePaths: [cwd], createdAt: new Date(T0).toISOString()
  }));
  fs.writeFileSync(path.join(sessionDir, 'sub-executions', 'x.jsonl'), ctx('sub', T0, 50));
  const messagesPath = path.join(sessionDir, 'messages.jsonl');
  fs.writeFileSync(messagesPath, '');
  return { home, cwd, messagesPath };
}

function createStore() {
  const records = [];
  const states = new Map();
  return {
    records,
    getFileState: (filePath) => states.get(filePath) || null,
    setFileState: (filePath, state) => states.set(filePath, state),
    insertUsageBatch: (batch) => {
      const fresh = batch.filter((item) => !records.some((existing) => existing.eventKey === item.eventKey));
      records.push(...fresh);
      return fresh.length;
    },
    upsertSessions: () => {}
  };
}

test('context usage becomes estimated tokens: window x percentage, prefix reuse as cache read, output by chars', () => {
  const parser = createKiroSessionLineParser({ model: 'claude-opus-5.5' });
  assert.equal(parser.parse(line('a1', T0, { type: 'assistant', content: 'x'.repeat(400) }), 0), null);
  const first = parser.parse(ctx('c1', T0 + 1000, 3), 1);
  assert.deepEqual(
    { input: first.inputTokens, cache: first.cacheReadInputTokens, output: first.outputTokens },
    { input: 30000, cache: 0, output: 100 }
  );
  const second = parser.parse(ctx('c2', T0 + 2000, 4), 2);
  assert.deepEqual({ input: second.inputTokens, cache: second.cacheReadInputTokens }, { input: 10000, cache: 30000 });
  // 超过缓存 TTL：冷启动，全部计输入。
  const cold = parser.parse(ctx('c3', T0 + 2000 + 10 * 60 * 1000, 4), 3);
  assert.deepEqual({ input: cold.inputTokens, cache: cold.cacheReadInputTokens }, { input: 40000, cache: 0 });
  assert.equal(cold.eventKey, 'kiro:context:c3');
});

test('unknown models never guess a context window', () => {
  const parser = createKiroSessionLineParser({ model: 'some-new-model' });
  parser.parse(line('a1', T0, { type: 'assistant', content: 'hello world!' }), 0);
  const event = parser.parse(ctx('c1', T0 + 1, 10), 1);
  assert.equal(event.inputTokens, 0);
  assert.equal(event.outputTokens, 3);
});

test('turn status classification follows the outcome closed set', () => {
  assert.equal(classifyKiroTurnStatus('success'), 'success');
  assert.equal(classifyKiroTurnStatus('error'), 'unclassified');
  assert.equal(classifyKiroTurnStatus('cancelled'), '');
  const parser = createKiroSessionLineParser({});
  const turn = parser.parse(line('u1', T0, {
    type: 'usage_summary', status: 'success', executionId: 'e1',
    promptTurnSummaries: [{ unit: 'credit', usage: 1.5 }, { unit: 'credit', usage: 0.25 }]
  }), 0);
  assert.equal(turn.kind, 'turn');
  assert.equal(turn.credits, 1.75);
});

test('registry scope ownership: live supervisor panes stay open, ambiguity fails closed', () => {
  const registry = {
    listEntries: () => [
      { provider: 'kiro', accountRef: ACCOUNT_A, cwd: '/work/project', createdAt: T0, updatedAt: T0, supervisorManaged: true },
      { provider: 'kiro', accountRef: ACCOUNT_B, cwd: '/work/other', createdAt: T0, updatedAt: T0 + 1000 },
      { provider: 'cline', accountRef: ACCOUNT_B, cwd: '/work/project', createdAt: T0, updatedAt: T0 + 1000 }
    ]
  };
  const ownership = createRegistryScopeOwnership({ provider: 'kiro', aiHomeDir: '/aih', registry });
  assert.equal(ownership.resolve({ cwd: '/work/project', atMs: T0 + 24 * 3600 * 1000 }).accountRef, ACCOUNT_A);
  assert.equal(ownership.resolve({ cwd: '/work/other', atMs: T0 + 24 * 3600 * 1000 }).reason, 'no_scope');
  const ambiguous = createRegistryScopeOwnership({
    provider: 'kiro',
    aiHomeDir: '/aih',
    registry: { listEntries: () => [
      { provider: 'kiro', accountRef: ACCOUNT_A, cwd: '/w', createdAt: T0, supervisorManaged: true },
      { provider: 'kiro', accountRef: ACCOUNT_B, cwd: '/w', createdAt: T0, supervisorManaged: true }
    ] }
  });
  assert.equal(ambiguous.resolve({ cwd: '/w', atMs: T0 + 1 }).reason, 'ambiguous_scope');
});

test('scanKiroSessionFile is incremental, attributes per event and ignores sub-executions', () => {
  const { home, cwd, messagesPath } = createFixture();
  try {
    const files = discoverKiroSessionFiles({ fs, path, hostHomeDir: home });
    assert.deepEqual(files, [messagesPath]);
    const store = createStore();
    const resolveOwnership = ({ cwd: sessionCwd, atMs }) => ({ accountRef: sessionCwd === cwd && atMs >= T0 ? ACCOUNT_A : '' });
    fs.appendFileSync(messagesPath, line('a1', T0, { type: 'assistant', content: 'abcd' }));
    fs.appendFileSync(messagesPath, ctx('c1', T0 + 1000, 1));
    // 半行（还没写完）：本轮不计，下一轮从它的起点重读。
    fs.appendFileSync(messagesPath, '{"id":"a2","timestamp":"2026-10-19T01:00:02.000Z","payload":{"type":"assis');
    const scan = () => scanKiroSessionFile({
      fs, path, store, filePath: messagesPath, readJsonlFromOffset: scanner.readJsonlFromOffset, resolveOwnership
    });
    assert.equal(scan().records, 1);
    assert.equal(store.records[0].accountRef, ACCOUNT_A);
    assert.equal(store.records[0].sourceKind, KIRO_SESSION_USAGE_SOURCE_KIND);
    assert.equal(store.records[0].model, 'claude-opus-5.5');
    assert.equal(store.records[0].inputTokens, 10000);
    assert.equal(store.records[0].outputTokens, 1);
    fs.appendFileSync(messagesPath, `tant","content":"${'y'.repeat(40)}"}}\n`);
    fs.appendFileSync(messagesPath, ctx('c2', T0 + 3000, 1.5));
    assert.equal(scan().records, 1);
    const second = store.records[1];
    assert.equal(second.cacheReadInputTokens, 10000);
    assert.equal(second.inputTokens, 5000);
    assert.equal(second.outputTokens, 10);
    assert.equal(scan().records, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('outcome poller template is idempotent and never advances past unattributed observations', () => {
  const recorded = [];
  let kv = {};
  let observations = [
    { key: 't1', marker: 'success', outcome: 'success', atMs: T0, accountRef: ACCOUNT_A },
    { key: 't2', marker: 'success', outcome: 'success', atMs: T0, accountRef: '' },
    { key: 't3', marker: 'cancelled', outcome: '', atMs: T0, accountRef: ACCOUNT_A }
  ];
  const poller = createNativeSessionOutcomePoller({
    aiHomeDir: '/aih',
    storeKey: 'test-outcomes',
    nodeAccountOutcomes: { record: (input) => { recorded.push(input); return true; } },
    collect: () => observations,
    readJsonValue: () => kv,
    writeJsonValue: (_fs, _dir, _key, value) => { kv = value; }
  });
  assert.deepEqual(poller.tick(), { scanned: 3, recorded: 1, unattributed: 1, skipped: 1 });
  assert.deepEqual(poller.tick(), { scanned: 3, recorded: 0, unattributed: 1, skipped: 1 });
  observations = [{ ...observations[1], accountRef: ACCOUNT_B }];
  assert.equal(poller.tick().recorded, 1);
  assert.deepEqual(recorded.map((item) => item.accountRef), [ACCOUNT_A, ACCOUNT_B]);
});

test('kiro turn collector turns usage_summary lines into attributed outcomes', () => {
  const { home, messagesPath } = createFixture();
  try {
    fs.appendFileSync(messagesPath, line('u1', T0 + 5000, { type: 'usage_summary', status: 'success', executionId: 'e1', promptTurnSummaries: [] }));
    fs.appendFileSync(messagesPath, line('u2', T0 + 9000, { type: 'usage_summary', status: 'error', executionId: 'e2', promptTurnSummaries: [] }));
    const collect = createKiroTurnCollector({
      fs,
      path,
      aiHomeDir: '/aih',
      hostHomeDir: home,
      registry: { listEntries: () => [{ provider: 'kiro', accountRef: ACCOUNT_A, cwd: '/work/project', createdAt: T0, supervisorManaged: true }] }
    });
    const observations = collect();
    assert.deepEqual(observations.map((item) => [item.key, item.outcome, item.accountRef]), [
      ['kiro:turn:u1', 'success', ACCOUNT_A],
      ['kiro:turn:u2', 'unclassified', ACCOUNT_A]
    ]);
    assert.deepEqual(collect(), [], 'offsets advance once everything is attributed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
