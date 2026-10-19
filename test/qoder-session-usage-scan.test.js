'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { __private: scannerPrivate } = require('../lib/usage/model-usage-scanner');

function withQoderTranscript(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'projects', '-work-demo');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, 'session-1.jsonl');
  const rows = [
    {
      type: 'user',
      sessionId: 'session-1',
      cwd: '/work/demo',
      timestamp: '2026-10-20T01:00:00.000Z',
      message: { role: 'user', content: '请解释这段代码' }
    },
    {
      type: 'assistant',
      sessionId: 'session-1',
      timestamp: '2026-10-20T01:00:01.000Z',
      message: {
        id: 'chatcmpl-1',
        role: 'assistant',
        model: 'qfmodel',
        content: [{ type: 'thinking', thinking: '先分析上下文' }]
      }
    },
    {
      type: 'assistant',
      sessionId: 'session-1',
      timestamp: '2026-10-20T01:00:02.000Z',
      message: {
        id: 'chatcmpl-1',
        role: 'assistant',
        model: 'qfmodel',
        content: [{ type: 'text', text: '这段代码做了两件事。' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          credits: 0.5,
          billable: true,
          request_id: 'req-1',
          context_usage_ratio: 0.25
        }
      }
    }
  ];
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { root, filePath };
}

function createStore() {
  const records = [];
  const sessions = [];
  return {
    records,
    sessions,
    getFileState: () => ({ size: 0, offset: 0, scanContext: {} }),
    insertUsageBatch: (batch) => {
      records.push(...batch);
      return batch.length;
    },
    insertPromptEvents: () => 0,
    upsertSessions: (batch) => sessions.push(...batch),
    setFileState: () => {}
  };
}

test('qoder session scanner estimates tokens from context ratio and accumulated thinking', (t) => {
  const { filePath } = withQoderTranscript(t);
  const store = createStore();
  const result = scannerPrivate.scanQoderSessionFile({
    fs,
    path,
    store,
    filePath,
    provider: 'qoder',
    accountRef: 'acct_0123456789abcdef'
  });

  assert.equal(result.records, 1);
  assert.equal(store.records.length, 1);
  const record = store.records[0];
  assert.equal(record.eventKey, 'qoder:message:chatcmpl-1');
  assert.equal(record.sourceKind, 'session_jsonl_estimated');
  assert.equal(record.inputTokens, 50000);
  // 输出 = 正文 9 个 CJK + 句号 + 思考 6 个 CJK
  assert.equal(record.outputTokens, 16);
  assert.equal(record.totalTokens, 50016);
  assert.equal(record.accountRef, 'acct_0123456789abcdef');
  assert.equal(record.model, 'qfmodel');
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0].promptCount, 1);
});

test('qoder session scanner keeps real counters and never marks them estimated', (t) => {
  const { filePath } = withQoderTranscript(t);
  const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  rows[2].message.usage = {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: 10,
    context_usage_ratio: 0.25
  };
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const store = createStore();
  scannerPrivate.scanQoderSessionFile({
    fs,
    path,
    store,
    filePath,
    provider: 'qoder',
    accountRef: ''
  });
  assert.equal(store.records[0].sourceKind, 'session_jsonl');
  assert.equal(store.records[0].inputTokens, 120);
  assert.equal(store.records[0].outputTokens, 30);
  assert.equal(store.records[0].cacheReadInputTokens, 10);
  assert.equal(store.records[0].totalTokens, 160);
});

test('qoder session scanner ignores assistant records without any usage evidence', (t) => {
  const { filePath } = withQoderTranscript(t);
  const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  delete rows[2].message.usage;
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const store = createStore();
  scannerPrivate.scanQoderSessionFile({
    fs,
    path,
    store,
    filePath,
    provider: 'qodercn',
    accountRef: ''
  });
  assert.equal(store.records.length, 0);
});
