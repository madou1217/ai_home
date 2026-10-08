'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanGrokUsageFile, discoverGrokUsageFiles } = require('../lib/usage/grok-model-usage-scanner');
const { __private: scannerPrivate } = require('../lib/usage/model-usage-scanner');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { stableHash } = require('../lib/usage/model-usage-stable-hash');

function makeStore() {
  const state = new Map();
  const usage = [];
  const prompts = [];
  const sessions = [];
  return {
    usage,
    prompts,
    sessions,
    getFileState(filePath) { return state.get(filePath) || { size: 0, offset: 0, scanContext: null }; },
    insertUsageBatch(records) { usage.push(...records); return records.length; },
    insertPromptEvents(records) { prompts.push(...records); return records.length; },
    upsertSessions(records) { sessions.push(...records); return records.length; },
    replaceFileProjection(input) {
      usage.splice(0, usage.length, ...input.usageRecords);
      prompts.splice(0, prompts.length, ...input.promptEvents);
      sessions.splice(0, sessions.length, ...input.sessionRecords);
      this.setFileState(input.filePath, input.fileState);
      return { records: input.usageRecords.length, prompts: input.promptEvents.length };
    },
    setFileState(filePath, next) { state.set(filePath, { ...next, scanContext: next.scanContext || null }); }
  };
}

test('Grok usage scanner records per-turn model usage and ignores context metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'sessions', '%2Fworkspace', 'session-1');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'summary.json'), JSON.stringify({
    info: { cwd: '/workspace/demo' },
    grok_home: path.join(root, 'run', 'auth-projections', 'grok', 'acct_1234567890abcdef1234', '.grok'),
    created_at: '2026-10-06T00:00:00Z'
  }));
  fs.writeFileSync(path.join(projectDir, 'updates.jsonl'), `${JSON.stringify({
    timestamp: 1_000,
    params: { _meta: { totalTokens: 999_999, agentTimestampMs: 1_700_000_000_000 }, update: {
      sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', usage: {
        inputTokens: 100, outputTokens: 20, modelUsage: {
          'grok-4.7': {
            inputTokens: 100, outputTokens: 20, cachedReadTokens: 10,
            cacheCreationTokens: 5, reasoningTokens: 4, costUsdTicks: 200_000_000
          }
        }
      }
    } }
  })}\n`);

  const store = makeStore();
  const result = scanGrokUsageFile({
    fs, path, store, filePath: path.join(projectDir, 'updates.jsonl'),
    aiHomeDir: root, readJsonlFromOffset: scannerPrivate.readJsonlFromOffset
  });
  assert.equal(result.records, 1);
  assert.equal(result.prompts, 1);
  assert.deepEqual(store.usage[0], {
    eventKey: store.usage[0].eventKey,
    provider: 'grok', sourceKind: 'session_jsonl', accountRef: 'acct_1234567890abcdef1234', sessionId: 'session-1',
    model: 'grok-4.7', inputTokens: 85, outputTokens: 16,
    cacheReadInputTokens: 10, cacheCreationInputTokens: 5, reasoningOutputTokens: 4,
    totalTokens: 120, costUsd: 0.02, timestampMs: 1_700_000_000_000, cwd: '/workspace/demo', project: 'demo'
  });
  assert.equal(store.usage[0].accountRef, 'acct_1234567890abcdef1234');
  assert.equal(store.sessions[0].promptCount, 1);
  assert.equal(store.usage[0].totalTokens, 120);
});

test('Grok usage discovery deduplicates shared host and account projection roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostSessions = path.join(root, 'host', '.grok', 'sessions', 'project', 'session-1');
  fs.mkdirSync(hostSessions, { recursive: true });
  fs.writeFileSync(path.join(hostSessions, 'updates.jsonl'), '{}\n');
  const accountRef = 'acct_1234567890abcdef1234';
  const projectionSessions = path.join(root, 'ai_home', 'run', 'auth-projections', 'grok', accountRef, '.grok', 'sessions');
  fs.mkdirSync(path.dirname(path.dirname(projectionSessions)), { recursive: true });
  fs.symlinkSync(path.join(root, 'host', '.grok'), path.join(root, 'ai_home', 'run', 'auth-projections', 'grok', accountRef, '.grok'));
  const files = discoverGrokUsageFiles({ fs, path, hostHomeDir: path.join(root, 'host'), aiHomeDir: path.join(root, 'ai_home'),
    listFilesRecursive: scannerPrivate.listFilesRecursive });
  assert.deepEqual(files, [fs.realpathSync(path.join(hostSessions, 'updates.jsonl'))]);
});

test('Grok session usage discovery reads only the completed session and rejects path traversal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-targeted-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, '.grok', 'sessions', '%2Fworkspace');
  for (const id of ['session-1', 'session-2']) {
    fs.mkdirSync(path.join(sessions, id), { recursive: true });
    fs.writeFileSync(path.join(sessions, id, 'updates.jsonl'), '{}\n');
  }
  const discover = (sessionId) => discoverGrokUsageFiles({
    fs, path, hostHomeDir: root, aiHomeDir: path.join(root, '.ai_home'), sessionId,
    listFilesRecursive: scannerPrivate.listFilesRecursive
  });
  assert.deepEqual(discover('session-2'), [fs.realpathSync(path.join(sessions, 'session-2', 'updates.jsonl'))]);
  for (const id of ['../session-2', '/session-2', 'session/2', 'session\\2']) {
    assert.deepEqual(discover(id), []);
  }
});

function createStoredSession(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-projection-'));
  const sessionDir = path.join(root, '.grok', 'sessions', 'project', 'session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'updates.jsonl');
  const summaryPath = path.join(sessionDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ info: { cwd: '/workspace/demo' } }));
  fs.writeFileSync(filePath, `${JSON.stringify({ params: {
    _meta: { agentTimestampMs: 1_700_000_000_000 },
    update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', usage: {
      modelUsage: { 'grok-4.7': { inputTokens: 100, outputTokens: 20, costUsdTicks: 200_000_000 } }
    } }
  } })}\n`);
  const store = openModelUsageStore({ fs, path, aiHomeDir: root });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scan = () => scanGrokUsageFile({
    fs, path, store, filePath, aiHomeDir: root, readJsonlFromOffset: scannerPrivate.readJsonlFromOffset
  });
  return { root, filePath, summaryPath, store, scan };
}

test('Grok stored usage follows changed session ownership without doubling tokens or prompts', (t) => {
  const { root, summaryPath, store, scan, filePath } = createStoredSession(t);
  const readUsage = () => store.db.prepare('SELECT account_ref, total_tokens, cost_usd FROM model_usage_records').all();
  assert.equal(scan().records, 1);
  assert.equal(readUsage()[0].account_ref, '');

  for (const accountRef of ['acct_1234567890abcdef1234', 'acct_abcdef1234567890abcd']) {
    fs.writeFileSync(summaryPath, JSON.stringify({
      info: { cwd: '/workspace/demo' },
      grok_home: path.join(root, 'run', 'auth-projections', 'grok', accountRef, '.grok')
    }));
    assert.equal(scan().records, 1);
    const rows = readUsage();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_ref, accountRef);
    assert.equal(rows[0].total_tokens, 120);
    assert.equal(rows[0].cost_usd, 0.02);
    assert.equal(store.getFileState(filePath).scanContext.attributedAccountRef, accountRef);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM model_usage_prompt_events').get().count, 1);
    assert.equal(store.db.prepare('SELECT prompt_count FROM model_usage_sessions').get().prompt_count, 1);
    assert.deepEqual(scan(), { records: 0, prompts: 0 });
  }
});

test('Grok file projection rejects API usage and preserves stored records and cursor', (t) => {
  const { filePath, store, scan } = createStoredSession(t);
  scan();
  const before = store.db.prepare('SELECT * FROM model_usage_records').all();
  const fileState = store.getFileState(filePath);
  const sourceHash = stableHash(filePath);
  assert.throws(() => store.replaceFileProjection({
    provider: 'grok', filePath, sourceHash,
    usageRecords: [{
      eventKey: `grok:file:${sourceHash}:api:usage`, provider: 'grok', sourceKind: 'api',
      model: 'grok-4.7', inputTokens: 999, timestampMs: 1_700_000_000_000
    }],
    promptEvents: [], sessionRecords: [], fileState: { size: 1, offset: 1 }
  }), /model_usage_file_projection_scope_invalid/);
  assert.deepEqual(store.db.prepare('SELECT * FROM model_usage_records').all(), before);
  assert.deepEqual(store.getFileState(filePath), fileState);
});
