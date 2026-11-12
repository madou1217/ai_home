'use strict';

// 用量账本增量推送：Node 承接的请求（钉选到自定义上游、Go 不路由）永远不经过 Go，
// Go 账本只能靠 Node 的 model_usage_records 补齐。这里守住四件事：
//   * 首轮把游标之后的新行推上去并推进游标；
//   * 游标之后的重复行不会再推（Go 侧还有 source_key 幂等兜底）；
//   * 发送失败时游标不前进，下一轮重试；
//   * 计数口径（input 含缓存）与 Node → Go 的账号 ref 翻译。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');
const { SYNC_STATE_KEY, createGoAccountSync, planFingerprint } = require('../lib/server/go-account-sync');
const { translateNodeAccount } = require('../lib/account/go-bridge/go-import-translator');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');

const ACCOUNT_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';
const GO_REF = 'acct_11111111111111111111';
const SESSION_ID = 'sess-usage-delta';
const OCCURRED_MS = 1793953548226;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gsync-usage-delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codexRecord(overrides = {}) {
  return {
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    cliAccountId: '1',
    createdAt: 1,
    updatedAt: 1,
    status: 'up',
    env: { OPENAI_API_KEY: 'sk-same-key', OPENAI_BASE_URL: 'https://api.example/v1' },
    nativeAuth: {},
    envUpdatedAt: 1000,
    nativeAuthUpdatedAt: 0,
    ...overrides
  };
}

function goCodexAccount() {
  return {
    accountRef: GO_REF,
    provider: 'codex',
    cliAccountId: 1,
    enabled: true,
    authKind: 'api_key',
    authMode: '',
    credential: { api_key: 'sk-same-key', base_url: 'https://api.example/v1' },
    credentialUpdatedAtMs: 1000,
    profile: {}
  };
}

// usageRow 按 Node 的原始计数构造：input 不含缓存，total 含缓存。
function usageRow(overrides = {}) {
  return {
    eventKey: 'codex:file:aaaaaaaaaaaaaaaa:1:usage',
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    sessionId: SESSION_ID,
    model: 'gpt-5.4',
    sourceKind: 'server_codex_proxy',
    inputTokens: 100,
    outputTokens: 30,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 5,
    reasoningOutputTokens: 10,
    totalTokens: 155,
    timestampMs: OCCURRED_MS,
    ...overrides
  };
}

function seedState(aiHomeDir, cursor) {
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, {
    links: {
      [ACCOUNT_REF]: {
        goRef: GO_REF,
        print: planFingerprint(translateNodeAccount(codexRecord()))
      }
    },
    modelPolicies: [],
    rejectedImports: {},
    usageLedgerCursor: cursor
  });
}

function seed(t, rows, options = {}) {
  const aiHomeDir = tmp(t);
  seedState(aiHomeDir, options.cursor || 0);
  const store = openModelUsageStore({ fs, aiHomeDir });
  store.insertUsageBatch(rows);
  const ids = store.db.prepare('SELECT id, event_key FROM model_usage_records ORDER BY id').all();
  store.close();

  const calls = [];
  const importCalls = [];
  let importReply = options.importReply
    || ((events) => ({ ok: true, status: 200, data: { data: { imported: events.length, skipped: 0 } } }));
  const client = new Proxy({
    async send(request) {
      calls.push({ method: request.method, path: request.path, body: request.body });
      return { ok: true, status: 200, data: { account_ref: GO_REF } };
    },
    async putUIState() {
      return { ok: true, status: 200, data: null };
    },
    async listUsageDocuments() {
      return { ok: true, status: 200, data: [] };
    },
    async listAccountUsage() {
      return { ok: true, status: 200, data: [] };
    }
  }, {
    get: (target, prop) => (prop in target ? target[prop] : async () => ({ ok: true, status: 200, data: null }))
  });
  const goHost = {
    async importUsageEvents(events) {
      importCalls.push(events);
      return typeof importReply === 'function' ? importReply(events) : importReply;
    }
  };
  const sync = createGoAccountSync({
    fs,
    aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts: [codexRecord()], defaults: {} }),
    readGoAccounts: () => ({ accounts: [goCodexAccount()], defaults: {} }),
    readModelCatalogSettings: () => ({}),
    getClient: () => client,
    goHost
  });
  return {
    sync,
    aiHomeDir,
    calls,
    importCalls,
    ids,
    setImportReply(next) { importReply = next; }
  };
}

function persistedCursor(aiHomeDir) {
  const state = readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY) || {};
  return state.usageLedgerCursor;
}

test('首轮把游标之后的新行推给 Go 并推进游标', async (t) => {
  const { sync, aiHomeDir, importCalls, ids } = seed(t, [
    usageRow(),
    // Go 自己记账后回灌到 Node 的镜像行：不能再推回去，否则重复计数。
    usageRow({
      eventKey: 'go:boot-1:7',
      sourceKind: 'server_go_gateway',
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 60
    }),
    usageRow({ eventKey: 'codex:file:bbbbbbbbbbbbbbbb:2:usage', model: 'gpt-5.4-mini' })
  ]);

  const result = await sync.reconcile();
  assert.equal(result.usageDeltaImported, 2);
  assert.equal(importCalls.length, 1);
  assert.equal(importCalls[0].length, 2, 'server_go_gateway 镜像行不推');

  const event = importCalls[0].find((item) => item.source_key === 'node:codex:file:aaaaaaaaaaaaaaaa:1:usage');
  assert.ok(event, '必须按 event_key 生成 source_key');
  assert.equal(event.account_ref, GO_REF, 'Node ref 要翻译成 Go ref');
  assert.equal(event.provider, 'codex');
  assert.equal(event.model, 'gpt-5.4');
  assert.equal(event.session_id, SESSION_ID);
  assert.equal(event.occurred_at_ms, OCCURRED_MS);
  // Node input 不含缓存，Go input 含缓存：100 + 20 + 5 = 125，total = 125 + 30 = 155。
  assert.equal(event.input_tokens, 125);
  assert.equal(event.cached_input_tokens, 20);
  assert.equal(event.cache_write_input_tokens, 5);
  assert.equal(event.output_tokens, 30);
  assert.equal(event.reasoning_tokens, 10);
  assert.equal(event.total_tokens, 155);

  // 游标越过本批最后一行（包括被跳过的 Go 镜像行），下一轮不会重读。
  assert.equal(persistedCursor(aiHomeDir), ids[ids.length - 1].id);
});

test('重复对账不再推送已越过游标的行；source_key 稳定可让 Go 幂等', async (t) => {
  const { sync, aiHomeDir, importCalls, setImportReply } = seed(t, [usageRow()]);

  await sync.reconcile();
  assert.equal(importCalls.length, 1);

  // 没有新行：一次导入请求都不该发。
  await sync.reconcile();
  assert.equal(importCalls.length, 1);

  // 模拟同步状态丢失、游标回到 0：相同事件会重推，但 source_key 不变，
  // Go 的唯一索引会把它们全部跳过。
  const state = readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY);
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, { ...state, usageLedgerCursor: 0 });
  setImportReply({ ok: true, status: 200, data: { data: { imported: 0, skipped: 1 } } });
  const result = await sync.reconcile();
  assert.equal(importCalls.length, 2);
  assert.deepEqual(
    importCalls[1].map((item) => item.source_key),
    importCalls[0].map((item) => item.source_key)
  );
  assert.equal(result.usageDeltaImported, 0);
});

test('发送失败时游标不前进，下一轮重试同一批', async (t) => {
  const { sync, aiHomeDir, importCalls, setImportReply, ids } = seed(t, [usageRow()], {
    importReply: { ok: false, status: 503, errorCode: 'go_core_unavailable' }
  });

  const failed = await sync.reconcile();
  assert.equal(failed.usageDeltaImported, 0);
  assert.ok(failed.errors.some((item) => item.step === 'usage_delta' && item.error === 'go_core_unavailable'));
  assert.equal(persistedCursor(aiHomeDir), 0);

  setImportReply({ ok: true, status: 200, data: { data: { imported: 1, skipped: 0 } } });
  const retried = await sync.reconcile();
  assert.equal(retried.usageDeltaImported, 1);
  assert.equal(importCalls.length, 2, '失败的那一轮也要在下一轮重发');
  assert.equal(persistedCursor(aiHomeDir), ids[ids.length - 1].id);
});
