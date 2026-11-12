'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverCodebuddyUsageFiles,
  scanCodebuddyUsageFile
} = require('../lib/usage/codebuddy-model-usage-scanner');
const { __private: scannerPrivate } = require('../lib/usage/model-usage-scanner');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cb-outcome-'));
}

function writeSession(home, sessionId, entries) {
  const projectDir = path.join(home, '.codebuddy', 'projects', 'project-a');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return filePath;
}

function createMockStore() {
  const batches = { records: [], outcomes: [], prompts: [] };
  return {
    db: { prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }) },
    getFileState: () => ({}),
    reconcileCodebuddyUsageBatch: (rows) => { batches.records.push(...rows); return rows.length; },
    insertNativeOutcomes: (rows) => { batches.outcomes.push(...rows); return rows.length; },
    insertPromptEvents: (rows) => { batches.prompts.push(...rows); return rows.length; },
    upsertSessions: () => {},
    setFileState: () => {},
    batches
  };
}

test('CodeBuddy 会话消息 → 健康结果：成功带 usage，失败按错误分类', () => {
  const home = tempHome();
  const sessionId = 'session-outcome';
  writeSession(home, sessionId, [
    { id: '01a1a0eb-d350-7449-ba39-d9487becf801', timestamp: 1793700000000, type: 'message', role: 'user', content: [] },
    {
      id: '01a1a0eb-d350-7449-ba39-d9487becf802',
      timestamp: 1793700001000,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      providerData: { model: 'deepseek-v4.1-flash', rawUsage: { prompt_tokens: 10, completion_tokens: 5 } }
    },
    {
      id: '01a1a0eb-d350-7449-ba39-d9487becf803',
      timestamp: 1793700002000,
      type: 'message',
      role: 'assistant',
      status: 'incomplete',
      providerData: { error: { message: '429 too many requests' } }
    },
    {
      id: '01a1a0eb-d350-7449-ba39-d9487becf804',
      timestamp: 1793700003000,
      type: 'message',
      role: 'assistant',
      status: 'incomplete',
      providerData: { error: { message: 'Empty stream', isStreamTimeout: true } }
    }
  ]);

  const [file] = discoverCodebuddyUsageFiles({
    fs,
    path,
    hostHomeDir: home,
    providers: ['codebuddy']
  });
  assert.ok(file);

  const store = createMockStore();
  const ownership = {
    fingerprint: 'fp',
    writerFingerprint: () => 'wf',
    resolveNative: () => ({ userId: 'user-1', accountRef: ACCOUNT_REF }),
    normalizeScope: () => null,
    resolve: () => ({ provider: 'codebuddy', accountRef: ACCOUNT_REF })
  };

  const result = scanCodebuddyUsageFile({
    fs,
    path,
    store,
    file,
    ownership,
    readJsonlFromOffset: scannerPrivate.readJsonlFromOffset
  });

  assert.equal(result.records, 1);
  assert.equal(result.outcomes, 3);
  assert.equal(store.batches.records[0].totalTokens, 15);

  const byOutcome = new Map(store.batches.outcomes.map((row) => [row.outcome, row]));
  assert.deepEqual([...byOutcome.keys()].sort(), ['rate_limited', 'stream_disconnected', 'success']);
  for (const row of store.batches.outcomes) {
    assert.equal(row.accountRef, ACCOUNT_REF);
    assert.equal(row.provider, 'codebuddy');
    // 结果键跨站点唯一：同一会话被 codebuddy / codebuddycn 各扫一次也只落一行。
    assert.match(row.eventKey, /^codebuddy:outcome:[a-f0-9]{16}:[a-f0-9]{16}$/);
  }
});

