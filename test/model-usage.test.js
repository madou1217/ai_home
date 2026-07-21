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
  LEGACY_UNKNOWN_MODEL,
  __private: modelUsageReadProjectionPrivate
} = require('../lib/usage/model-usage-read-projection');
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

test('model usage records reject events without a model identity', () => {
  assert.equal(normalizeUsageRecord({
    eventKey: 'usage-without-model',
    provider: 'codex',
    inputTokens: 10,
    timestampMs: Date.now()
  }), null);
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

test('codex scanner excludes inherited fork history and keeps the child session identity', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const childSessionId = '019f698a-a7b0-7041-b4a2-41cfb5f0de48';
    const parentSessionId = '019f522d-bc5c-75d2-a42c-cbf33a7b706a';
    const childTurnId = '019f698a-ac84-7f00-99ef-96047d656de1';
    const filePath = path.join(
      root,
      '.codex',
      'sessions',
      '2026',
      '07',
      '16',
      `rollout-2026-07-16T14-08-42-${childSessionId}.jsonl`
    );
    const usage = (input, output) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output
    });
    const tokenCount = (timestamp, total, last) => ({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: total, last_token_usage: last }
      }
    });

    writeJsonl(filePath, [
      {
        timestamp: '2026-07-16T06:08:42.998Z',
        type: 'session_meta',
        payload: {
          id: childSessionId,
          cwd: '/work/child',
          forked_from_id: parentSessionId,
          thread_source: 'subagent',
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: parentSessionId }
            }
          }
        }
      },
      {
        timestamp: '2026-07-16T06:08:42.998Z',
        type: 'session_meta',
        payload: { id: parentSessionId, cwd: '/work/parent' }
      },
      {
        timestamp: '2026-07-16T06:08:42.999Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: '019f522e-47f4-7b21-883e-1eb75437eef1'
        }
      },
      {
        timestamp: '2026-07-16T06:08:42.999Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: '769ef34d-8867-4ebf-a8ca-943122e24602'
        }
      },
      {
        timestamp: '2026-07-16T06:08:42.999Z',
        type: 'turn_context',
        turn_id: '019f522e-47f4-7b21-883e-1eb75437eef1',
        payload: { model: 'gpt-5.6-sol' }
      },
      tokenCount('2026-07-16T06:08:43.000Z', usage(1000, 100), usage(1000, 100)),
      {
        timestamp: '2026-07-16T06:08:43.667Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: childTurnId,
          started_at: 1784182123
        }
      },
      {
        timestamp: '2026-07-16T06:08:43.706Z',
        type: 'turn_context',
        turn_id: childTurnId,
        payload: { model: 'gpt-5.6-sol' }
      },
      tokenCount('2026-07-16T06:08:57.318Z', usage(50, 5), usage(50, 5))
    ]);

    const firstScan = service.scan({ provider: 'codex' });
    assert.equal(firstScan.providers.codex.records, 1);

    const query = {
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    };
    assert.deepEqual(service.getCostByModel(query).map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: row.calls,
      totalTokens: row.totalTokens
    })), [{
      provider: 'codex',
      model: 'gpt-5.6-sol',
      calls: 1,
      totalTokens: 55
    }]);
    assert.deepEqual(service.getSessions(query).map((row) => row.sessionId), [childSessionId]);

    const secondScan = service.scan({ provider: 'codex' });
    assert.equal(secondScan.providers.codex.records, 0);
    assert.equal(service.getStats(query).totalCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex scanner keeps fork replay pending across incremental scans', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const childSessionId = '019f698a-a7b0-7041-b4a2-41cfb5f0de48';
    const parentSessionId = '019f522d-bc5c-75d2-a42c-cbf33a7b706a';
    const childTurnId = '019f698a-ac84-7f00-99ef-96047d656de1';
    const filePath = path.join(
      root,
      '.codex',
      'sessions',
      '2026',
      '07',
      '16',
      `rollout-2026-07-16T14-08-42-${childSessionId}.jsonl`
    );
    const usage = {
      input_tokens: 50,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 55
    };
    const tokenCount = (timestamp) => ({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: usage, last_token_usage: usage }
      }
    });
    const replayRows = [
      {
        timestamp: '2026-07-16T06:08:42.998Z',
        type: 'session_meta',
        payload: {
          id: childSessionId,
          cwd: '/work/child',
          forked_from_id: parentSessionId,
          thread_source: 'subagent'
        }
      },
      {
        timestamp: '2026-07-16T06:08:42.998Z',
        type: 'session_meta',
        payload: { id: parentSessionId, cwd: '/work/parent' }
      },
      {
        timestamp: '2026-07-16T06:08:42.999Z',
        type: 'turn_context',
        turn_id: '019f522e-47f4-7b21-883e-1eb75437eef1',
        payload: { model: 'gpt-5.6-sol' }
      },
      tokenCount('2026-07-16T06:08:43.000Z')
    ];
    writeJsonl(filePath, replayRows);

    const replayScan = service.scan({ provider: 'codex' });
    assert.equal(replayScan.providers.codex.records, 0);
    assert.equal(replayScan.providers.codex.prompts, 0);
    const query = {
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    };
    service.recordUsage({
      eventKey: modelUsageScannerPrivate.buildFileEventKey('codex', filePath, 0, 'usage'),
      provider: 'codex',
      sourceKind: 'session_jsonl',
      sessionId: parentSessionId,
      model: 'gpt-5.6-sol',
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      timestampMs: Date.parse('2026-07-16T06:08:43.000Z')
    });
    assert.equal(service.getStats(query).totalCalls, 0);

    fs.appendFileSync(filePath, [
      {
        timestamp: '2026-07-16T06:08:43.667Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: childTurnId }
      },
      {
        timestamp: '2026-07-16T06:08:43.706Z',
        type: 'turn_context',
        turn_id: childTurnId,
        payload: { model: 'gpt-5.6-sol' }
      },
      {
        timestamp: '2026-07-16T06:08:43.707Z',
        type: 'inter_agent_communication_metadata',
        payload: { trigger_turn: true }
      },
      {
        timestamp: '2026-07-16T06:08:43.708Z',
        type: 'response_item',
        payload: { type: 'user_message', message: 'inspect child task' }
      },
      tokenCount('2026-07-16T06:08:57.318Z')
    ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const childScan = service.scan({ provider: 'codex' });
    assert.equal(childScan.providers.codex.records, 1);
    assert.equal(childScan.providers.codex.prompts, 1);

    assert.equal(service.getStats(query).totalCalls, 1);
    assert.deepEqual(service.getSessions(query).map((row) => row.sessionId), [childSessionId]);

    const completeScan = service.scan({ provider: 'codex' });
    assert.equal(completeScan.providers.codex.records, 0);
    assert.equal(completeScan.providers.codex.prompts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical usage reads hide legacy fork replay records without deleting raw events', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  try {
    const childSessionId = '019f698a-a7b0-7041-b4a2-41cfb5f0de48';
    const parentSessionId = '019f522d-bc5c-75d2-a42c-cbf33a7b706a';
    const childTurnId = '019f698a-ac84-7f00-99ef-96047d656de1';
    const filePath = path.join(
      root,
      '.codex',
      'sessions',
      '2026',
      '07',
      '16',
      `rollout-2026-07-16T14-08-42-${childSessionId}.jsonl`
    );
    const usage = (input, output) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output
    });
    const tokenCount = (timestamp, value) => ({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: value, last_token_usage: value }
      }
    });
    const rows = [
      {
        timestamp: '2026-07-16T06:08:42.998Z',
        type: 'session_meta',
        payload: {
          id: childSessionId,
          cwd: '/work/child',
          forked_from_id: parentSessionId,
          thread_source: 'subagent'
        }
      },
      {
        timestamp: '2026-07-16T06:08:42.998Z',
        type: 'session_meta',
        payload: { id: parentSessionId, cwd: '/work/parent' }
      },
      {
        timestamp: '2026-07-16T06:08:42.999Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' }
      },
      {
        timestamp: '2026-07-16T06:08:42.999Z',
        type: 'response_item',
        payload: { type: 'user_message', message: 'inherited parent prompt' }
      },
      tokenCount('2026-07-16T06:08:43.000Z', usage(1000, 100)),
      {
        timestamp: '2026-07-16T06:08:43.667Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: childTurnId }
      },
      {
        timestamp: '2026-07-16T06:08:43.706Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' }
      },
      {
        timestamp: '2026-07-16T06:08:43.707Z',
        type: 'response_item',
        payload: { type: 'user_message', message: 'real child prompt' }
      },
      tokenCount('2026-07-16T06:08:57.318Z', usage(50, 5))
    ];
    const serialized = rows.map((row) => JSON.stringify(row));
    let nextOffset = 0;
    const offsets = serialized.map((line) => {
      const offset = nextOffset;
      nextOffset += Buffer.byteLength(`${line}\n`);
      return offset;
    });
    writeTextFile(filePath, `${serialized.join('\n')}\n`);

    service.recordUsageBatch([
      {
        eventKey: modelUsageScannerPrivate.buildFileEventKey('codex', filePath, offsets[4], 'usage'),
        provider: 'codex',
        sourceKind: 'session_jsonl',
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        timestampMs: Date.parse('2026-07-16T06:08:43.000Z')
      },
      {
        eventKey: modelUsageScannerPrivate.buildFileEventKey('codex', filePath, offsets[8], 'usage'),
        provider: 'codex',
        sourceKind: 'session_jsonl',
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        inputTokens: 50,
        outputTokens: 5,
        totalTokens: 55,
        timestampMs: Date.parse('2026-07-16T06:08:57.318Z')
      }
    ]);
    const seedDb = new DatabaseSync(path.join(root, '.ai_home', 'app-state.db'));
    try {
      seedDb.prepare(`
        UPDATE model_usage_records
        SET model = ''
        WHERE session_id = ? AND input_tokens = 1000
      `).run(parentSessionId);
      const insertPrompt = seedDb.prepare(`
        INSERT INTO model_usage_prompt_events(event_key, provider, session_id, timestamp_ms)
        VALUES (?, 'codex', ?, ?)
      `);
      insertPrompt.run(
        modelUsageScannerPrivate.buildFileEventKey('codex', filePath, offsets[3], 'prompt'),
        parentSessionId,
        Date.parse('2026-07-16T06:08:42.999Z')
      );
      insertPrompt.run(
        modelUsageScannerPrivate.buildFileEventKey('codex', filePath, offsets[7], 'prompt'),
        parentSessionId,
        Date.parse('2026-07-16T06:08:43.707Z')
      );
    } finally {
      seedDb.close();
    }

    assert.equal(service.scan({ provider: 'codex' }).providers.codex.records, 0);
    const query = {
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    };
    assert.equal(service.getStats(query).totalCalls, 1);
    assert.equal(service.getStats(query).totalTokens, 55);
    assert.equal(service.getStats(query).totalPrompts, 1);
    assert.deepEqual(service.getCostByModel(query).map((row) => [row.model, row.calls]), [
      ['gpt-5.6-sol', 1]
    ]);
    assert.deepEqual(service.getSessionDetail({
      ...query,
      provider: 'codex',
      sessionId: childSessionId
    }).map((row) => [row.sessionId, row.calls]), [[childSessionId, 1]]);
    assert.deepEqual(service.getSessions(query).map((row) => ({
      sessionId: row.sessionId,
      cwd: row.cwd,
      project: row.project,
      promptCount: row.promptCount
    })), [{
      sessionId: childSessionId,
      cwd: '/work/child',
      project: 'child',
      promptCount: 1
    }]);

    const verifyDb = new DatabaseSync(path.join(root, '.ai_home', 'app-state.db'));
    try {
      assert.equal(verifyDb.prepare('SELECT COUNT(*) AS count FROM model_usage_records').get().count, 2);
      assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM model_usage_records WHERE model = ''").get().count, 1);
      assert.equal(verifyDb.prepare('SELECT COUNT(*) AS count FROM model_usage_prompt_events').get().count, 2);
    } finally {
      verifyDb.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical usage reads label legacy unknown models without losing accounting', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  try {
    const timestampMs = new Date(2025, 11, 1, 12).getTime();
    service.getStats({ fromMs: timestampMs, toMs: timestampMs });
    const db = new DatabaseSync(path.join(root, '.ai_home', 'app-state.db'));
    try {
      db.prepare(`
        INSERT INTO model_usage_records (
          event_key, provider, session_id, source_kind, model,
          input_tokens, output_tokens, total_tokens,
          timestamp_ms, project, cwd, created_at_ms
        ) VALUES (?, 'codex', 'legacy-session', 'session_jsonl', '',
          40, 2, 42, ?, 'legacy-project', '/work/legacy', ?)
      `).run('legacy:codex:unknown-model', timestampMs, timestampMs);
    } finally {
      db.close();
    }

    const query = { fromMs: timestampMs, toMs: timestampMs };
    assert.deepEqual(service.getStats(query), {
      totalCalls: 1,
      totalSessions: 1,
      totalPrompts: 0,
      inputTokens: 40,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 42,
      totalCostUsd: 0
    });
    assert.deepEqual(service.getCostByModel(query).map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: row.calls,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd
    })), [{
      provider: 'codex',
      model: LEGACY_UNKNOWN_MODEL,
      calls: 1,
      totalTokens: 42,
      costUsd: 0
    }]);
    assert.equal(service.getStats({ ...query, model: LEGACY_UNKNOWN_MODEL }).totalTokens, 42);
    assert.equal(service.getCostByModel({ ...query, model: LEGACY_UNKNOWN_MODEL }).length, 1);
    assert.deepEqual(service.getSessions(query).map((row) => [
      row.sessionId,
      row.calls,
      row.totalTokens
    ]), [['legacy-session', 1, 42]]);
    assert.deepEqual(service.getSessionDetail({
      ...query,
      provider: 'codex',
      sessionId: 'legacy-session'
    }).map((row) => [row.model, row.calls, row.totalTokens, row.costUsd]), [
      [LEGACY_UNKNOWN_MODEL, 1, 42, 0]
    ]);

    const verifyDb = new DatabaseSync(path.join(root, '.ai_home', 'app-state.db'));
    try {
      const raw = verifyDb.prepare(`
        SELECT model
        FROM model_usage_records
        WHERE event_key = 'legacy:codex:unknown-model'
      `).get();
      assert.equal(raw.model, '');
    } finally {
      verifyDb.close();
    }
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

test('model usage pricing maintenance recalculates existing zero-cost records explicitly', async (t) => {
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
    assert.equal(sync.recalculated, 0);
    assert.equal(sync.recalculationRequired, true);
    assert.equal(fetchCalls, 1);
    assert.equal(service.getStats(query).totalCostUsd, 0);

    const maintenance = await service.syncPricingIfStale({ recalculateCosts: true });
    assert.equal(maintenance.ok, true);
    assert.equal(maintenance.recalculated, 1);
    assert.equal(maintenance.recalculationRequired, false);
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

test('model usage pricing resolves attributed and Code Assist billing model identities', () => {
  const pricing = {
    'google/gemini-3.5-flash': {
      model: 'google/gemini-3.5-flash',
      inputCostPerToken: 0.0000015,
      outputCostPerToken: 0.000009
    },
    'openai/gpt-5.6-sol': {
      model: 'openai/gpt-5.6-sol',
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00003
    },
    '302ai/claude-opus-4-6-thinking': {
      model: '302ai/claude-opus-4-6-thinking',
      inputCostPerToken: 999
    },
    'anthropic/claude-opus-4-6': {
      model: 'anthropic/claude-opus-4-6',
      inputCostPerToken: 0.000005
    }
  };

  assert.equal(
    matchModelPricing('agy.gemini-3-flash-agent', pricing, 'claude').model,
    'google/gemini-3.5-flash'
  );
  assert.equal(
    matchModelPricing('codex.gpt-5.6-sol', pricing, 'claude').model,
    'openai/gpt-5.6-sol'
  );
  assert.equal(
    matchModelPricing('agy.claude-opus-4-6-thinking', pricing, 'claude').model,
    'anthropic/claude-opus-4-6'
  );
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
    assert.equal(sync.recalculated, 0);
    assert.equal(sync.recalculationRequired, true);
    assert.equal(service.getStats(query).totalCostUsd, 9);

    const maintenance = await service.syncPricingIfStale({ recalculateCosts: true });
    assert.equal(maintenance.recalculated, 1);
    assert.equal(maintenance.recalculationRequired, false);

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

test('model usage worker reads preserve synchronous projection results', async (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { service } = fixture;
  t.after(() => service.close());
  const timestampMs = Date.parse('2026-06-05T10:00:00Z');
  service.recordUsage({
    eventKey: 'async-worker-usage',
    provider: 'codex',
    sessionId: 'async-worker-session',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.1-codex',
    inputTokens: 12,
    outputTokens: 8,
    timestampMs
  });
  const query = {
    fromMs: timestampMs - 1,
    toMs: timestampMs + 1,
    provider: 'codex',
    sessionId: 'async-worker-session',
    limit: 50
  };
  const expected = {
    dashboard: service.getDashboard(query),
    stats: service.getStats(query),
    models: service.getCostByModel(query),
    sessions: service.getSessions(query),
    detail: service.getSessionDetail(query)
  };

  const [dashboard, stats, models, sessions, detail] = await Promise.all([
    service.getDashboardAsync(query),
    service.getStatsAsync(query),
    service.getCostByModelAsync(query),
    service.getSessionsAsync(query),
    service.getSessionDetailAsync(query)
  ]);

  assert.deepEqual({ dashboard, stats, models, sessions, detail }, expected);
});

test('model usage exposes the canonical native model timeline for one session', (t) => {
  const fixture = makeService(t, { enableAsyncQueries: false });
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    service.recordUsage({
      eventKey: 'agy:native-done:session-1:run-1',
      provider: 'agy',
      sessionId: 'session-1',
      sourceKind: 'native_session_done',
      model: 'gemini-3.6-flash-tiered',
      timestampMs: Date.parse('2026-07-21T09:05:53Z')
    });
    service.recordUsage({
      eventKey: 'agy:api:session-1:unrelated',
      provider: 'agy',
      sessionId: 'session-1',
      sourceKind: 'api',
      model: 'transcript-label',
      timestampMs: Date.parse('2026-07-21T09:06:00Z')
    });
    service.recordUsage({
      eventKey: 'agy:native-done:session-1:run-2',
      provider: 'agy',
      sessionId: 'session-1',
      sourceKind: 'native_session_done',
      model: 'claude-opus-4-6-thinking',
      timestampMs: Date.parse('2026-07-21T09:11:09Z')
    });

    assert.deepEqual(service.getNativeSessionModelTimeline('agy', 'session-1'), [
      {
        model: 'gemini-3.6-flash-tiered',
        timestampMs: Date.parse('2026-07-21T09:05:53Z')
      },
      {
        model: 'claude-opus-4-6-thinking',
        timestampMs: Date.parse('2026-07-21T09:11:09Z')
      }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model usage dashboard keeps model options unfiltered in one canonical snapshot', (t) => {
  const fixture = makeService(t, { enableAsyncQueries: false });
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = Date.parse('2026-06-05T10:00:00Z');
    service.recordUsageBatch([
      {
        eventKey: 'dashboard-selected-model',
        provider: 'codex',
        sessionId: 'dashboard-session-a',
        sourceKind: 'server_codex_proxy',
        model: 'gpt-5.1-codex',
        inputTokens: 12,
        outputTokens: 8,
        timestampMs
      },
      {
        eventKey: 'dashboard-option-model',
        provider: 'codex',
        sessionId: 'dashboard-session-b',
        sourceKind: 'server_codex_proxy',
        model: 'gpt-5.2-codex',
        inputTokens: 6,
        outputTokens: 4,
        timestampMs
      }
    ]);
    const query = {
      fromMs: timestampMs - 1,
      toMs: timestampMs + 1,
      provider: 'codex',
      model: 'gpt-5.1-codex',
      limit: 50
    };

    const dashboard = service.getDashboard(query);

    assert.deepEqual(dashboard.stats, service.getStats(query));
    assert.deepEqual(dashboard.models, service.getCostByModel(query));
    assert.deepEqual(dashboard.sessions, service.getSessions(query));
    assert.deepEqual(
      dashboard.modelOptions,
      service.getCostByModel({ ...query, model: '' })
    );
    assert.deepEqual(dashboard.models.map((row) => row.model), ['gpt-5.1-codex']);
    assert.deepEqual(
      dashboard.modelOptions.map((row) => row.model).sort(),
      ['gpt-5.1-codex', 'gpt-5.2-codex']
    );
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

test('aggregation attributes a cross-provider proxy copy to the real client once', (t) => {
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
      {
        eventKey: 'claude:file:/p/s.jsonl:1:usage',
        provider: 'claude',
        sessionId: 'claude-session',
        sourceKind: 'session_jsonl',
        model: 'gemini-3-flash-agent',
        inputTokens: 30,
        outputTokens: 7,
        timestampMs: timestampMs + 10_000
      },
      {
        eventKey: 'api:agy:req_cross_provider:1',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'gemini-3-flash-agent',
        inputTokens: 30,
        outputTokens: 7,
        reasoningOutputTokens: 5,
        totalTokens: 42,
        timestampMs: timestampMs + 10_250
      },
      // An unmatched proxy event is still a real standalone AGY observation.
      {
        eventKey: 'api:agy:req_unmatched:1',
        provider: 'agy',
        sessionId: 'agy-session',
        sourceKind: 'server_proxy',
        model: 'gemini-standalone',
        inputTokens: 11,
        outputTokens: 4,
        timestampMs: timestampMs + 20_000
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    const stats = service.getStats(query);
    assert.equal(stats.totalCalls, 3, 'each real client event is counted once');
    assert.equal(stats.totalTokens, 120 + 37 + 15);
    assert.equal(service.getStats({ ...query, provider: 'claude' }).totalCalls, 2);
    assert.equal(service.getStats({ ...query, model: 'agy.gemini-3-flash-agent' }).totalCalls, 1);

    const models = service.getCostByModel(query);
    const nativeClaude = models.find((row) => row.model === 'claude-sonnet-4-6');
    assert.equal(nativeClaude.provider, 'claude');
    assert.equal(nativeClaude.calls, 1);

    const routedClaude = models.find((row) => row.model === 'agy.gemini-3-flash-agent');
    assert.equal(routedClaude.provider, 'claude');
    assert.equal(routedClaude.calls, 1);
    assert.equal(routedClaude.inputTokens, 30);
    assert.equal(routedClaude.outputTokens, 7);
    assert.equal(routedClaude.reasoningOutputTokens, 0, 'client-visible usage wins');

    const agy = models.find((row) => row.provider === 'agy');
    assert.equal(agy.model, 'gemini-standalone');
    assert.equal(agy.calls, 1, 'unmatched AGY proxy row is preserved');

    const filtered = service.getCostByModel({ ...query, model: 'agy.gemini-3-flash-agent' });
    assert.deepEqual(filtered.map((row) => [row.provider, row.model, row.calls]), [
      ['claude', 'agy.gemini-3-flash-agent', 1]
    ]);

    const sessions = service.getSessions(query);
    assert.equal(sessions.find((row) => row.provider === 'claude').calls, 2);
    assert.equal(sessions.find((row) => row.provider === 'agy').calls, 1);
    assert.deepEqual(
      service.getSessionDetail({
        ...query,
        provider: 'claude',
        sessionId: 'claude-session'
      }).map((row) => [row.provider, row.model, row.calls]),
      [
        ['claude', 'claude-sonnet-4-6', 1],
        ['claude', 'agy.gemini-3-flash-agent', 1]
      ]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregation pairs scanner and proxy observations one-to-one and preserves unmatched proxy rows', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:first:usage',
        provider: 'claude',
        sessionId: 'claude-session',
        sourceKind: 'session_jsonl',
        model: 'gemini-3-flash-agent',
        inputTokens: 30,
        outputTokens: 7,
        timestampMs
      },
      {
        eventKey: 'claude:file:second:usage',
        provider: 'claude',
        sessionId: 'claude-session',
        sourceKind: 'session_jsonl',
        model: 'gemini-3-flash-agent',
        inputTokens: 30,
        outputTokens: 7,
        timestampMs: timestampMs + 100
      },
      {
        eventKey: 'api:agy:single-proxy',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'gemini-wire-model',
        inputTokens: 30,
        outputTokens: 7,
        timestampMs: timestampMs + 50
      },
      {
        eventKey: 'api:claude:unmatched-proxy',
        provider: 'claude',
        sourceKind: 'server_proxy',
        model: 'claude-haiku-4-5',
        inputTokens: 9,
        outputTokens: 2,
        timestampMs: timestampMs + 20_000
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    const models = service.getCostByModel(query);
    assert.equal(service.getStats(query).totalCalls, 3);
    assert.equal(models.find((row) => row.model === 'agy.gemini-wire-model').calls, 1);
    assert.equal(models.find((row) => row.model === 'gemini-3-flash-agent').calls, 1);
    assert.equal(models.find((row) => row.model === 'claude-haiku-4-5').calls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregation matches cache-split cross-provider observations one-to-one', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:cache-split-first:usage',
        provider: 'claude',
        sessionId: 'cache-split-first',
        sourceKind: 'session_jsonl',
        model: 'gemini-cache-client',
        inputTokens: 100,
        outputTokens: 12,
        totalTokens: 112,
        timestampMs
      },
      {
        eventKey: 'claude:file:cache-split-second:usage',
        provider: 'claude',
        sessionId: 'cache-split-second',
        sourceKind: 'session_jsonl',
        model: 'gemini-cache-client',
        inputTokens: 100,
        outputTokens: 12,
        totalTokens: 112,
        timestampMs: timestampMs + 600
      },
      {
        eventKey: 'api:agy:cache-split-first',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'gemini-cache-first',
        inputTokens: 25,
        outputTokens: 7,
        cacheReadInputTokens: 75,
        reasoningOutputTokens: 5,
        totalTokens: 112,
        timestampMs: timestampMs + 100
      },
      {
        eventKey: 'api:agy:cache-split-second',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'gemini-cache-second',
        inputTokens: 60,
        outputTokens: 7,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 112,
        timestampMs: timestampMs + 700
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    assert.equal(service.getStats(query).totalCalls, 2);
    assert.equal(service.getStats(query).totalTokens, 224);

    const detailFields = (row) => [
      row.model,
      row.calls,
      row.inputTokens,
      row.cacheReadInputTokens,
      row.cacheCreationInputTokens,
      row.outputTokens,
      row.reasoningOutputTokens,
      row.totalTokens
    ];
    assert.deepEqual(service.getSessionDetail({
      ...query,
      provider: 'claude',
      sessionId: 'cache-split-first'
    }).map(detailFields), [
      ['agy.gemini-cache-first', 1, 100, 0, 0, 12, 0, 112]
    ]);
    assert.deepEqual(service.getSessionDetail({
      ...query,
      provider: 'claude',
      sessionId: 'cache-split-second'
    }).map(detailFields), [
      ['agy.gemini-cache-second', 1, 100, 0, 0, 12, 0, 112]
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observation matching reroutes the nearest edge to maximize one-to-one attribution', () => {
  const candidates = [
    {
      scannerId: 1,
      proxyId: 1,
      scannerTimestampMs: 1_000,
      deltaMs: 100,
      sessionRank: 0
    },
    {
      scannerId: 2,
      proxyId: 1,
      scannerTimestampMs: 2_000,
      deltaMs: 700,
      sessionRank: 0
    },
    {
      scannerId: 1,
      proxyId: 2,
      scannerTimestampMs: 1_000,
      deltaMs: 900,
      sessionRank: 0
    }
  ];

  const matches = modelUsageReadProjectionPrivate.matchObservationCandidates(candidates);

  assert.deepEqual(matches.map(({ scannerId, proxyId }) => [scannerId, proxyId]), [
    [2, 1],
    [1, 2]
  ]);
});

test('observation matching preserves session priority within a maximum matching', () => {
  const candidates = [
    {
      scannerId: 1,
      proxyId: 1,
      scannerTimestampMs: 1_000,
      deltaMs: 697,
      sessionRank: 0
    },
    {
      scannerId: 1,
      proxyId: 3,
      scannerTimestampMs: 1_000,
      deltaMs: 584,
      sessionRank: 1
    },
    {
      scannerId: 2,
      proxyId: 1,
      scannerTimestampMs: 2_000,
      deltaMs: 137,
      sessionRank: 1
    },
    {
      scannerId: 2,
      proxyId: 3,
      scannerTimestampMs: 2_000,
      deltaMs: 434,
      sessionRank: 1
    }
  ];

  const matches = modelUsageReadProjectionPrivate.matchObservationCandidates(candidates);

  assert.deepEqual(matches.map(({ scannerId, proxyId }) => [scannerId, proxyId]), [
    [1, 1],
    [2, 3]
  ]);
});

test('aggregation matches Claude and AGY observations with split thinking tokens', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:agy-thinking-client:usage',
        provider: 'claude',
        sessionId: 'claude-thinking-session',
        sourceKind: 'session_jsonl',
        model: 'gemini-3-flash-agent',
        inputTokens: 30,
        outputTokens: 12,
        cacheReadInputTokens: 3,
        totalTokens: 45,
        timestampMs
      },
      {
        eventKey: 'api:agy:thinking-execution',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'gemini-3-flash-a',
        inputTokens: 30,
        outputTokens: 7,
        cacheReadInputTokens: 3,
        reasoningOutputTokens: 5,
        totalTokens: 45,
        timestampMs: timestampMs + 200
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    assert.deepEqual(service.getCostByModel(query).map((row) => [
      row.provider,
      row.model,
      row.calls,
      row.outputTokens,
      row.reasoningOutputTokens,
      row.totalTokens
    ]), [['claude', 'agy.gemini-3-flash-a', 1, 12, 0, 45]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregation matches Codex observations across split reasoning tokens', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'codex:file:reasoning-client:usage',
        provider: 'codex',
        sessionId: 'codex-reasoning-session',
        sourceKind: 'session_jsonl',
        model: 'gpt-5.6-sol',
        inputTokens: 40,
        outputTokens: 8,
        cacheReadInputTokens: 4,
        reasoningOutputTokens: 4,
        totalTokens: 56,
        timestampMs
      },
      {
        eventKey: 'api:codex:reasoning-execution',
        provider: 'codex',
        sourceKind: 'server_codex_proxy',
        model: 'gpt-5.6-sol',
        inputTokens: 40,
        outputTokens: 12,
        cacheReadInputTokens: 4,
        totalTokens: 56,
        timestampMs: timestampMs + 200
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    assert.deepEqual(service.getCostByModel(query).map((row) => [
      row.provider,
      row.model,
      row.calls,
      row.outputTokens,
      row.reasoningOutputTokens,
      row.totalTokens
    ]), [['codex', 'gpt-5.6-sol', 1, 8, 4, 56]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregation attributes Claude scanner usage to a Codex execution model', (t) => {
  const fixture = makeService(t);
  if (!fixture) return;
  const { root, service } = fixture;
  try {
    const timestampMs = new Date(2026, 5, 4, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:codex-client:usage',
        provider: 'claude',
        sessionId: 'claude-codex-session',
        sourceKind: 'session_jsonl',
        model: 'gpt-5.6-sol',
        inputTokens: 40,
        outputTokens: 8,
        timestampMs
      },
      {
        eventKey: 'api:codex:claude-client-proxy',
        provider: 'codex',
        sourceKind: 'server_codex_proxy',
        model: 'gpt-5.6-sol',
        inputTokens: 40,
        outputTokens: 8,
        timestampMs: timestampMs + 200
      }
    ]);

    const query = {
      fromMs: new Date(2026, 5, 4).getTime(),
      toMs: new Date(2026, 5, 5).getTime() - 1
    };
    assert.deepEqual(service.getCostByModel(query).map((row) => [
      row.provider,
      row.model,
      row.calls,
      row.totalTokens
    ]), [['claude', 'codex.gpt-5.6-sol', 1, 48]]);
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
