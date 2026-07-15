const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { buildApiUsageRecord } = require('../lib/usage/model-usage-api-record');
const { matchModelPricing } = require('../lib/usage/model-usage-pricing');
const {
  normalizeUsageRecord,
  __private: modelUsageStorePrivate
} = require('../lib/usage/model-usage-store');
const {
  __private: modelUsageScannerPrivate
} = require('../lib/usage/model-usage-scanner');
const {
  parseModelUsageArgs,
  __private: modelAccountingPrivate
} = require('../lib/cli/services/usage/model-accounting');

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeService(t, overrides = {}) {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return {
    root,
    service: createModelUsageService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir: root,
      DatabaseSync,
      ...overrides
    })
  };
}

test('model usage schema rejects local account_id instead of migrating it', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE model_usage_records (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT ''
      )
    `);

    assert.throws(
      () => modelUsageStorePrivate.assertUsageAccountRefSchema(db),
      /model_usage_account_ref_schema_invalid/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(model_usage_records)').all().map((row) => row.name),
      ['id', 'account_id']
    );
  } finally {
    db.close();
  }
});

test('model usage pricing schema rejects legacy columns without mutating data', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE model_usage_pricing (
        model TEXT PRIMARY KEY,
        input_cost_per_token REAL NOT NULL DEFAULT 0,
        output_cost_per_token REAL NOT NULL DEFAULT 0,
        cache_read_input_token_cost REAL NOT NULL DEFAULT 0,
        cache_creation_input_token_cost REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        updated_at_ms INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO model_usage_pricing (
        model, input_cost_per_token, output_cost_per_token, source, updated_at_ms
      ) VALUES ('legacy-model', 1, 2, 'legacy', 123);
    `);

    assert.throws(
      () => modelUsageStorePrivate.ensureSchema(db),
      /model_usage_pricing_schema_invalid/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(model_usage_pricing)').all().map((row) => row.name),
      [
        'model',
        'input_cost_per_token',
        'output_cost_per_token',
        'cache_read_input_token_cost',
        'cache_creation_input_token_cost',
        'source',
        'updated_at_ms'
      ]
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM model_usage_pricing').all().map((row) => ({ ...row })),
      [{
        model: 'legacy-model',
        input_cost_per_token: 1,
        output_cost_per_token: 2,
        cache_read_input_token_cost: 0,
        cache_creation_input_token_cost: 0,
        source: 'legacy',
        updated_at_ms: 123
      }]
    );
  } finally {
    db.close();
  }
});

test('model usage records accept only accountRef as the runtime account key', () => {
  const baseRecord = {
    eventKey: 'usage-account-ref-contract',
    provider: 'codex',
    model: 'gpt-5.5',
    timestampMs: Date.now()
  };

  assert.equal(
    normalizeUsageRecord({ ...baseRecord, accountRef: 'acct_0123456789abcdefabcd' }).accountRef,
    'acct_0123456789abcdefabcd'
  );
  assert.throws(
    () => normalizeUsageRecord({ ...baseRecord, accountRef: '1' }),
    /model_usage_account_ref_invalid/
  );
  ['accountId', 'account_id', 'account_ref'].forEach((field) => {
    assert.throws(
      () => normalizeUsageRecord({ ...baseRecord, [field]: '1' }),
      /model_usage_account_key_invalid/
    );
  });
});

test('model usage file event keys hash source paths to keep indexes bounded', () => {
  const sourcePath = `/Users/model/${'very-long-project/'.repeat(20)}session.jsonl`;
  const eventKey = modelUsageScannerPrivate.buildFileEventKey(
    'codex',
    sourcePath,
    123,
    'usage'
  );

  assert.match(eventKey, /^codex:file:[a-f0-9]{16}:123:usage$/);
  assert.equal(eventKey.includes(sourcePath), false);
  assert.equal(
    eventKey,
    modelUsageScannerPrivate.buildFileEventKey('codex', sourcePath, 123, 'usage')
  );
});

test('model usage scanner applies provider-specific Codex, Claude, and Gemini rules', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const codexSessionId = '11111111-1111-4111-8111-111111111111';
    writeJsonl(path.join(root, '.codex', 'sessions', '2026', '06', '04', `rollout-2026-06-04T08-00-00-${codexSessionId}.jsonl`), [
      {
        timestamp: '2026-06-04T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: codexSessionId, cwd: '/work/codex-project', cli_version: '1.0.0' }
      },
      {
        timestamp: '2026-06-04T08:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5-codex' }
      },
      {
        timestamp: '2026-06-04T08:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
      },
      {
        timestamp: '2026-06-04T08:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            // codex reports cumulative totals; for the first turn total == last.
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 10,
              reasoning_output_tokens: 5
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 10,
              reasoning_output_tokens: 5
            }
          }
        }
      }
    ]);

    const claudeSessionId = 'claude-session-1';
    writeJsonl(path.join(root, '.claude', 'projects', 'claude-project', `${claudeSessionId}.jsonl`), [
      {
        timestamp: '2026-06-04T09:00:00.000Z',
        type: 'user',
        sessionId: claudeSessionId,
        cwd: '/work/claude-project',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'skip' }] }
      },
      {
        timestamp: '2026-06-04T09:00:01.000Z',
        type: 'user',
        sessionId: claudeSessionId,
        cwd: '/work/claude-project',
        message: { content: 'real prompt' }
      },
      {
        timestamp: '2026-06-04T09:00:02.000Z',
        type: 'assistant',
        sessionId: claudeSessionId,
        cwd: '/work/claude-project',
        gitBranch: 'main',
        message: {
          id: 'msg_claude_stream_1',
          role: 'assistant',
          model: 'claude-sonnet-4.6',
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1
          }
        }
      },
      {
        timestamp: '2026-06-04T09:00:03.000Z',
        type: 'assistant',
        sessionId: claudeSessionId,
        cwd: '/work/claude-project',
        gitBranch: 'main',
        message: {
          id: 'msg_claude_stream_1',
          role: 'assistant',
          model: 'claude-sonnet-4.6',
          content: [{ type: 'text', text: 'same response, later stream fragment' }],
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1
          }
        }
      }
    ]);

    const geminiFile = path.join(root, '.gemini', 'tmp', 'gemini-project', 'chats', 'session-1.json');
    fs.mkdirSync(path.dirname(geminiFile), { recursive: true });
    fs.mkdirSync(path.join(root, '.gemini', 'history', 'gemini-project'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gemini', 'history', 'gemini-project', '.project_root'), '/work/gemini-project', 'utf8');
    fs.writeFileSync(geminiFile, JSON.stringify({
      sessionId: 'gemini-session-1',
      startTime: '2026-06-04T10:00:00.000Z',
      lastUpdated: '2026-06-04T10:00:03.000Z',
      messages: [
        { id: 'u1', timestamp: '2026-06-04T10:00:01.000Z', type: 'user', content: 'hello' },
        {
          id: 'g1',
          timestamp: '2026-06-04T10:00:02.000Z',
          type: 'gemini',
          model: 'gemini-3.1-pro-preview',
          tokens: { input: 100, output: 5, cached: 20, thoughts: 7, total: 112 }
        }
      ]
    }), 'utf8');

    const scan = service.scan();
    assert.equal(scan.records, 3);
    assert.equal(scan.prompts, 3);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    const stats = service.getStats(query);
    assert.equal(stats.totalCalls, 3);
    assert.equal(stats.totalPrompts, 3);
    assert.equal(stats.totalTokens, 110 + 13 + 112);

    const models = service.getCostByModel(query);
    const codex = models.find((item) => item.provider === 'codex');
    const claude = models.find((item) => item.provider === 'claude');
    const gemini = models.find((item) => item.provider === 'gemini');
    assert.deepEqual({
      model: codex.model,
      input: codex.inputTokens,
      cache: codex.cacheReadInputTokens,
      output: codex.outputTokens,
      reasoning: codex.reasoningOutputTokens
    }, {
      model: 'gpt-5-codex',
      input: 60,
      cache: 40,
      output: 5,
      reasoning: 5
    });
    assert.equal(claude.cacheCreationInputTokens, 1);
    assert.equal(gemini.inputTokens, 80);
    assert.equal(gemini.cacheReadInputTokens, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage API record normalizes OpenAI cached prompt tokens', () => {
  const accountRef = 'acct_1234567890abcdef1234';
  const record = buildApiUsageRecord({
    provider: 'codex',
    accountRef,
    requestId: 'req_1',
    model: 'gpt-5-codex',
    timestampMs: 1770000000000,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: {
        cached_tokens: 30
      }
    }
  });
  assert.equal(record.inputTokens, 70);
  assert.equal(record.cacheReadInputTokens, 30);
  assert.equal(record.outputTokens, 25);
  assert.equal(record.totalTokens, 125);
  assert.match(record.eventKey, new RegExp(`^api:codex:req_1:${accountRef}:`));
});

test('model usage API record infers protocol usage shape before provider default', () => {
  const geminiOpenAiRecord = buildApiUsageRecord({
    provider: 'gemini',
    accountRef: 'acct_2234567890abcdef1234',
    requestId: 'req_gemini_openai',
    model: 'gemini-chat-adapter',
    timestampMs: 1770000000000,
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25
    }
  });
  assert.equal(geminiOpenAiRecord.inputTokens, 20);
  assert.equal(geminiOpenAiRecord.outputTokens, 5);
  assert.equal(geminiOpenAiRecord.totalTokens, 25);

  const agyGeminiRecord = buildApiUsageRecord({
    provider: 'agy',
    accountRef: 'acct_3234567890abcdef1234',
    requestId: 'req_agy_gemini',
    model: 'claude-through-code-assist',
    timestampMs: 1770000000001,
    usage: {
      promptTokenCount: 30,
      candidatesTokenCount: 7,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 10,
      totalTokenCount: 39
    }
  });
  assert.equal(agyGeminiRecord.inputTokens, 20);
  assert.equal(agyGeminiRecord.cacheReadInputTokens, 10);
  assert.equal(agyGeminiRecord.outputTokens, 7);
  assert.equal(agyGeminiRecord.reasoningOutputTokens, 2);
  assert.equal(agyGeminiRecord.totalTokens, 39);
});

test('model usage pricing sync recalculates existing zero-cost records', async (t) => {
  let fetchCalls = 0;
  const fixture = makeService(t, {
    pricingUrl: 'https://example.test/model-prices.json',
    fetchImpl: async (url) => {
      fetchCalls += 1;
      assert.equal(url, 'https://example.test/model-prices.json');
      return {
        ok: true,
        async json() {
          return {
            'gpt-test-pricing': {
              input_cost_per_token: 0.000001,
              output_cost_per_token: 0.000002,
              cache_read_input_token_cost: 0.0000001,
              cache_creation_input_token_cost: 0.0000002
            }
          };
        }
      };
    }
  });
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    service.recordUsage({
      eventKey: 'api:codex:req_pricing:1',
      provider: 'codex',
      accountRef: 'acct_1234567890abcdef1234',
      requestId: 'req_pricing',
      sourceKind: 'api',
      model: 'gpt-test-pricing',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      timestampMs: new Date(2026, 5, 4, 12).getTime()
    });

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    assert.equal(service.getStats(query).totalCostUsd, 0);

    const sync = await service.syncPricingIfStale({ force: true });
    assert.equal(sync.ok, true);
    assert.equal(sync.synced, true);
    assert.equal(sync.upserted, 1);
    assert.equal(sync.recalculated, 1);
    assert.equal(fetchCalls, 1);

    const stats = service.getStats(query);
    assert.ok(Math.abs(stats.totalCostUsd - 0.000202) < 0.000000001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage pricing prefers provider-qualified standard price over stale exact price', () => {
  const pricing = {
    'gpt-standard': { model: 'gpt-standard', inputCostPerToken: 999 },
    'openai/gpt-standard': { model: 'openai/gpt-standard', inputCostPerToken: 0.000001 },
    'anthropic/claude-sonnet-4-6': { model: 'anthropic/claude-sonnet-4-6', inputCostPerToken: 0.000003 },
    'github-copilot/claude-sonnet-4-6': { model: 'github-copilot/claude-sonnet-4-6', inputCostPerToken: 0.000004 }
  };
  assert.equal(matchModelPricing('gpt-standard', pricing, 'codex').model, 'openai/gpt-standard');
  assert.equal(matchModelPricing('claude-sonnet-4.6', pricing, 'agy').model, 'github-copilot/claude-sonnet-4-6');
});

test('model usage pricing sync uses models.dev standard costs per million tokens', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-models-dev-pricing-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync,
    modelsDevDir,
    fetchImpl: async () => {
      throw new Error('unexpected_network_pricing_fetch');
    }
  });
  try {
    writeTextFile(path.join(modelsDevDir, 'providers', 'openai', 'models', 'gpt-standard.toml'), `
[cost]
input = 1
output = 2
reasoning = 3
cache_read = 0.1
cache_write = 0.2

[[cost.tiers]]
tier = { size = 100 }
input = 10
output = 20
reasoning = 30
cache_read = 1
cache_write = 2
`);

    service.recordUsage({
      eventKey: 'api:codex:req_models_dev_pricing:1',
      provider: 'codex',
      accountRef: 'acct_1234567890abcdef1234',
      requestId: 'req_models_dev_pricing',
      sourceKind: 'api',
      model: 'gpt-standard',
      inputTokens: 80,
      outputTokens: 10,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 5,
      reasoningOutputTokens: 2,
      costUsd: 9,
      timestampMs: new Date(2026, 5, 4, 12).getTime()
    });

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    assert.equal(service.getStats(query).totalCostUsd, 9);

    const sync = await service.syncPricingIfStale({ force: true });
    assert.equal(sync.ok, true);
    assert.equal(sync.synced, true);
    assert.equal(sync.source, 'models.dev');
    assert.equal(sync.upserted, 1);
    assert.equal(sync.recalculated, 1);

    const stats = service.getStats(query);
    assert.ok(Math.abs(stats.totalCostUsd - 0.0011) < 0.000000001);

    const fresh = await service.syncPricingIfStale();
    assert.equal(fresh.ok, true);
    assert.equal(fresh.synced, false);
    assert.equal(fresh.reason, 'fresh');
    assert.equal(fresh.source, 'models.dev');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage service falls back to host .ai_home when aiHomeDir is omitted', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root } = fixture;
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir: '',
    hostHomeDir: root,
    DatabaseSync
  });
  try {
    service.recordUsage({
      eventKey: 'api:codex:req_fallback:1',
      provider: 'codex',
      accountRef: 'acct_1234567890abcdef1234',
      requestId: 'req_fallback',
      sourceKind: 'api',
      model: 'gpt-fallback',
      inputTokens: 10,
      outputTokens: 5,
      timestampMs: new Date(2026, 5, 4, 12).getTime()
    });
    const stats = service.getStats({
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    });
    assert.equal(stats.totalCalls, 1);
    assert.equal(fs.existsSync(path.join(root, '.ai_home', 'app-state.db')), true);
    assert.equal(fs.existsSync(path.join(root, '.ai_home', 'model-usage.db')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage service resolves node sqlite when DatabaseSync option is omitted', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-default-sqlite-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root
  });
  try {
    service.recordUsage({
      eventKey: 'api:codex:req_default_sqlite:1',
      provider: 'codex',
      accountRef: 'acct_1234567890abcdef1234',
      requestId: 'req_default_sqlite',
      sourceKind: 'api',
      model: 'gpt-default-sqlite',
      inputTokens: 6,
      outputTokens: 4,
      timestampMs: new Date(2026, 5, 4, 12).getTime()
    });
    const stats = service.getStats({
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    });
    assert.equal(stats.totalCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex scanner tracks interleaved cumulative streams without duplicate or reset inflation', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const filePath = path.join(
      root,
      '.codex',
      'sessions',
      '2026',
      '06',
      '04',
      `rollout-2026-06-04T08-00-00-${sessionId}.jsonl`
    );
    const usage = (input, cached, output, reasoning) => ({
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output
    });
    const meta = (total, last, second) => ({
      timestamp: `2026-06-04T08:00:${String(second).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: total,
          last_token_usage: last
        }
      }
    });
    const streamA1 = meta(usage(1000, 400, 100, 20), usage(1000, 400, 100, 20), 1);
    const streamB1 = meta(usage(700, 200, 70, 10), usage(700, 200, 70, 10), 3);
    writeJsonl(filePath, [
      { timestamp: '2026-06-04T08:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: '/work/p' } },
      { timestamp: '2026-06-04T08:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } },
      streamA1,
      { ...streamA1, timestamp: '2026-06-04T08:00:02.000Z' },
      streamB1,
      meta(usage(1500, 700, 160, 30), usage(500, 300, 60, 10), 4),
      { ...streamB1, timestamp: '2026-06-04T08:00:05.000Z' },
      meta(usage(1000, 400, 90, 15), usage(300, 200, 20, 5), 6),
      meta(usage(250, 50, 25, 5), usage(250, 50, 25, 5), 7)
    ]);

    const firstScan = service.scan({ provider: 'codex' });
    assert.equal(firstScan.providers.codex.records, 5);

    fs.appendFileSync(filePath, [
      JSON.stringify({ ...streamB1, timestamp: '2026-06-04T08:00:08.000Z' }),
      JSON.stringify(meta(usage(1700, 800, 180, 35), usage(200, 100, 20, 5), 9)),
      JSON.stringify(meta(usage(300, 75, 35, 8), usage(50, 25, 10, 3), 10))
    ].join('\n') + '\n', 'utf8');

    const secondScan = service.scan({ provider: 'codex' });
    assert.equal(secondScan.providers.codex.records, 2);

    const query = {
      provider: 'codex',
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    const stats = service.getStats(query);
    assert.equal(stats.totalCalls, 7);
    assert.equal(stats.totalTokens, 3305);
    assert.equal(stats.inputTokens, 1725);
    assert.equal(stats.cacheReadInputTokens, 1275);
    assert.equal(stats.outputTokens, 247);
    assert.equal(stats.reasoningOutputTokens, 58);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregation drops the redundant proxy copy for file-scanned providers but keeps agy', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    // claude is observed twice for the same request: once by the local session
    // scanner, once by the proxy recorder. They carry different event keys, so
    // INSERT-dedup cannot merge them — the aggregation layer must.
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:/p/s.jsonl:0:usage',
        provider: 'claude',
        sessionId: 'claude-session',
        sourceKind: 'session_jsonl',
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 20,
        timestampMs
      },
      {
        eventKey: 'api:claude:req_dup:1',
        provider: 'claude',
        sessionId: 'claude-session',
        sourceKind: 'server_proxy',
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 20,
        timestampMs
      },
      // agy has no scannable local log, so its proxy copy is the only record and
      // must still be counted.
      {
        eventKey: 'api:agy:req_agy:1',
        provider: 'agy',
        sessionId: 'agy-session',
        sourceKind: 'server_proxy',
        model: 'claude-through-code-assist',
        inputTokens: 30,
        outputTokens: 7,
        timestampMs
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    const stats = service.getStats(query);
    // claude counted once (120), not twice (240); agy's 37 still included.
    assert.equal(stats.totalCalls, 2, 'redundant claude proxy row excluded');
    assert.equal(stats.totalTokens, 120 + 37);

    const claude = service.getCostByModel(query).find((row) => row.provider === 'claude');
    assert.equal(claude.calls, 1, 'claude collapses to its single session row');
    assert.equal(claude.inputTokens, 100);
    assert.equal(claude.outputTokens, 20);

    const agy = service.getCostByModel(query).find((row) => row.provider === 'agy');
    assert.equal(agy.calls, 1, 'agy proxy row preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage sessions query qualifies provider filter across joined tables', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'api:codex:req_session_filter:1',
        provider: 'codex',
        sessionId: 'codex-session',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        timestampMs
      },
      {
        eventKey: 'api:gemini:req_session_filter:1',
        provider: 'gemini',
        sessionId: 'gemini-session',
        model: 'gemini-3.1-pro-preview',
        inputTokens: 20,
        outputTokens: 7,
        timestampMs
      }
    ]);

    const sessions = service.getSessions({
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1,
      provider: 'gemini'
    });
    assert.deepEqual(sessions.map((item) => [item.provider, item.sessionId]), [
      ['gemini', 'gemini-session']
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage CLI parser keeps model accounting distinct from quota usage', () => {
  const parsed = parseModelUsageArgs([
    'models',
    '--from', '2026-06-01',
    '--to', '2026-06-04',
    '--provider', 'codex',
    '--model', 'gpt-5-codex',
    '--no-scan',
    '--json'
  ]);
  assert.equal(parsed.command, 'models');
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.model, 'gpt-5-codex');
  assert.equal(parsed.scan, false);
  assert.equal(parsed.json, true);

  const range = modelAccountingPrivate.normalizeDateRange(parsed.from, parsed.to);
  assert.equal(range.from, '2026-06-01');
  assert.equal(range.to, '2026-06-04');
  assert.ok(range.toMs > range.fromMs);
});
