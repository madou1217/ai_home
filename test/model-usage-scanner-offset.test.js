'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  __private: scannerPrivate
} = require('../lib/usage/model-usage-scanner');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');

const SCAN_CHUNK_BYTES = 256 * 1024;

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

function withTempFile(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-offset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'session.jsonl');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function createForkFixture(t) {
  const childSessionId = '019f698a-a7b0-7041-b4a2-41cfb5f0de48';
  const parentSessionId = '019f522d-bc5c-75d2-a42c-cbf33a7b706a';
  const childTurnId = '019f698a-aa56-7000-8000-000000000000';
  const rowsBeforeSplit = [
    {
      timestamp: '2026-07-16T06:08:42.998Z',
      type: 'session_meta',
      payload: {
        id: childSessionId,
        cwd: '/work/child',
        forked_from_id: parentSessionId
      }
    },
    {
      timestamp: '2026-07-16T06:08:42.999Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol' }
    }
  ].map((row) => JSON.stringify(row));
  const splitMarker = '__SPLIT_UTF8_MARKER__';
  let inheritedLine = JSON.stringify({
    timestamp: '2026-07-16T06:08:43.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: splitMarker }]
    }
  });
  const markerIndex = inheritedLine.indexOf(splitMarker);
  const bytesBeforeMarker = Buffer.byteLength(
    `${rowsBeforeSplit.join('\n')}\n${inheritedLine.slice(0, markerIndex)}`
  );
  const fillerBytes = (
    SCAN_CHUNK_BYTES - 1 - (bytesBeforeMarker % SCAN_CHUNK_BYTES) + SCAN_CHUNK_BYTES
  ) % SCAN_CHUNK_BYTES;
  inheritedLine = inheritedLine.replace(splitMarker, `${'x'.repeat(fillerBytes)}中`);

  const serialized = [
    ...rowsBeforeSplit,
    inheritedLine,
    JSON.stringify({
      timestamp: '2026-07-16T06:08:43.667Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: childTurnId }
    }),
    JSON.stringify({
      timestamp: '2026-07-16T06:08:43.706Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol' }
    }),
    JSON.stringify({
      timestamp: '2026-07-16T06:08:43.707Z',
      type: 'response_item',
      payload: { type: 'user_message', message: 'real child prompt' }
    }),
    JSON.stringify({
      timestamp: '2026-07-16T06:08:57.318Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 60,
            cached_input_tokens: 10,
            output_tokens: 7,
            reasoning_output_tokens: 2
          },
          last_token_usage: {
            input_tokens: 60,
            cached_input_tokens: 10,
            output_tokens: 7,
            reasoning_output_tokens: 2
          }
        }
      }
    })
  ];
  let cursor = 0;
  const offsets = serialized.map((line) => {
    const offset = cursor;
    cursor += Buffer.byteLength(`${line}\n`);
    return offset;
  });
  const filePath = withTempFile(t, `${serialized.join('\n')}\n`);
  const splitCharacterOffset = Buffer.byteLength(
    `${serialized.slice(0, 2).join('\n')}\n${inheritedLine.slice(0, inheritedLine.indexOf('中'))}`
  );
  assert.equal(splitCharacterOffset % SCAN_CHUNK_BYTES, SCAN_CHUNK_BYTES - 1);
  const sourceHash = scannerPrivate
    .buildFileEventKey('codex', filePath, 0, 'usage')
    .split(':')[2];
  return {
    childSessionId,
    filePath,
    fileSize: cursor,
    offsets,
    sourceHash
  };
}

function seedLegacyForkProjection(store, fixture) {
  const legacyUsageKey = scannerPrivate.buildFileEventKey(
    'codex',
    fixture.filePath,
    fixture.offsets[6] + 6,
    'usage'
  );
  const legacyPromptKey = scannerPrivate.buildFileEventKey(
    'codex',
    fixture.filePath,
    fixture.offsets[5] + 6,
    'prompt'
  );
  store.insertUsageBatch([
    {
      eventKey: legacyUsageKey,
      provider: 'codex',
      sourceKind: 'session_jsonl',
      sessionId: fixture.childSessionId,
      model: 'gpt-5.6-sol',
      inputTokens: 600,
      outputTokens: 70,
      totalTokens: 670,
      timestampMs: Date.parse('2026-07-16T06:08:57.318Z')
    },
    {
      eventKey: 'codex:file:0123456789abcdef:9:usage',
      provider: 'codex',
      sourceKind: 'session_jsonl',
      sessionId: 'unrelated-session',
      model: 'gpt-5.6-sol',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      timestampMs: Date.parse('2026-07-16T06:09:00.000Z')
    }
  ]);
  store.insertPromptEvents([
    {
      eventKey: legacyPromptKey,
      provider: 'codex',
      sessionId: fixture.childSessionId,
      timestampMs: Date.parse('2026-07-16T06:08:43.707Z')
    },
    {
      eventKey: 'codex:file:0123456789abcdef:8:prompt',
      provider: 'codex',
      sessionId: 'unrelated-session',
      timestampMs: Date.parse('2026-07-16T06:09:00.000Z')
    }
  ]);
  store.upsertSessions([{
    provider: 'codex',
    sessionId: fixture.childSessionId,
    cwd: '/work/legacy',
    project: 'legacy',
    gitBranch: 'legacy-branch',
    startedAtMs: Date.parse('2026-07-15T06:08:42.998Z'),
    updatedAtMs: Date.parse('2026-07-17T06:08:57.318Z'),
    promptCount: 9
  }]);
  store.setFileState(fixture.filePath, {
    size: fixture.fileSize,
    offset: fixture.fileSize,
    scanContext: {
      sessionId: fixture.childSessionId,
      cwd: '/work/legacy',
      model: 'gpt-5.6-sol'
    }
  });
  return { legacyPromptKey, legacyUsageKey };
}

function readProjectionSnapshot(store, fixture) {
  return {
    usage: store.db.prepare(`
      SELECT event_key, session_id, total_tokens
      FROM model_usage_records
      ORDER BY event_key
    `).all().map((row) => [row.event_key, row.session_id, row.total_tokens]),
    prompts: store.db.prepare(`
      SELECT event_key, session_id
      FROM model_usage_prompt_events
      ORDER BY event_key
    `).all().map((row) => [row.event_key, row.session_id]),
    sessions: store.db.prepare(`
      SELECT provider, session_id, project, cwd, prompt_count
      FROM model_usage_sessions
      ORDER BY provider, session_id
    `).all().map((row) => [
      row.provider,
      row.session_id,
      row.project,
      row.cwd,
      row.prompt_count
    ]),
    fileState: store.getFileState(fixture.filePath)
  };
}

test('JSONL reader keeps byte offsets across split UTF-8, CRLF, and an unterminated tail', (t) => {
  const firstLine = `${'a'.repeat(SCAN_CHUNK_BYTES - 1)}中`;
  const secondLine = 'second';
  const tailLine = 'tail';
  const filePath = withTempFile(t, `${firstLine}\n${secondLine}\r\n${tailLine}`);
  const rows = [];

  scannerPrivate.readJsonlFromOffset(fs, filePath, 0, (line, offset) => {
    rows.push({ line, offset });
  });

  const secondOffset = Buffer.byteLength(`${firstLine}\n`);
  assert.deepEqual(rows, [
    { line: firstLine, offset: 0 },
    { line: secondLine, offset: secondOffset },
    { line: tailLine, offset: secondOffset + Buffer.byteLength(`${secondLine}\r\n`) }
  ]);
});

test('incremental and full JSONL scans produce the same event key after split UTF-8', (t) => {
  const prefixLine = `${'a'.repeat(SCAN_CHUNK_BYTES - 1)}中`;
  const prefix = `${prefixLine}\n`;
  const eventLine = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } });
  const filePath = withTempFile(t, prefix);
  const incrementalOffset = Buffer.byteLength(prefix);
  fs.appendFileSync(filePath, `${eventLine}\n`, 'utf8');

  const incrementalRows = [];
  scannerPrivate.readJsonlFromOffset(fs, filePath, incrementalOffset, (line, offset) => {
    incrementalRows.push({ line, offset });
  });
  const fullRows = [];
  scannerPrivate.readJsonlFromOffset(fs, filePath, 0, (line, offset) => {
    fullRows.push({ line, offset });
  });

  const incrementalKey = scannerPrivate.buildFileEventKey(
    'codex',
    filePath,
    incrementalRows[0].offset,
    'usage'
  );
  const fullKey = scannerPrivate.buildFileEventKey(
    'codex',
    filePath,
    fullRows[1].offset,
    'usage'
  );
  assert.equal(incrementalRows[0].line, eventLine);
  assert.equal(fullRows[1].line, eventLine);
  assert.equal(fullKey, incrementalKey);
});

test('background scans persist a Codex fork deferred marker only once', (t) => {
  const sessionMeta = JSON.stringify({
    timestamp: '2026-07-16T06:08:42.998Z',
    type: 'session_meta',
    payload: {
      id: '019f698a-a7b0-7041-b4a2-41cfb5f0de48',
      cwd: '/work/child',
      forked_from_id: '019f522d-bc5c-75d2-a42c-cbf33a7b706a'
    }
  });
  const filePath = withTempFile(t, `${sessionMeta}\n`);
  let state = {
    size: fs.statSync(filePath).size,
    offset: fs.statSync(filePath).size,
    scanContext: {
      sessionId: '019f698a-a7b0-7041-b4a2-41cfb5f0de48',
      cwd: '/work/child',
      model: 'gpt-5.6-sol'
    }
  };
  let stateWrites = 0;
  const store = {
    getFileState: () => state,
    setFileState: (_path, nextState) => {
      stateWrites += 1;
      state = nextState;
    }
  };

  const first = scannerPrivate.scanCodexFile({ fs, path, store, filePath });
  const second = scannerPrivate.scanCodexFile({ fs, path, store, filePath });

  assert.equal(first.reindexRequired, 1);
  assert.equal(second.reindexRequired, 1);
  assert.equal(stateWrites, 1);
});

test('explicit Codex fork reindex replaces drifted file rows with correct byte-offset rows', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const fixture = createForkFixture(t);
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(path.dirname(fixture.filePath), '.ai_home'),
    DatabaseSync
  });
  assert.ok(store);
  try {
    const legacy = seedLegacyForkProjection(store, fixture);

    const result = scannerPrivate.scanCodexFile({
      fs,
      path,
      store,
      filePath: fixture.filePath,
      reindexCodexForkHistory: true
    });

    const expectedUsageKey = scannerPrivate.buildFileEventKey(
      'codex', fixture.filePath, fixture.offsets[6], 'usage'
    );
    const expectedPromptKey = scannerPrivate.buildFileEventKey(
      'codex', fixture.filePath, fixture.offsets[5], 'prompt'
    );
    const scopedUsage = store.db.prepare(`
      SELECT event_key, session_id, total_tokens
      FROM model_usage_records
      WHERE event_key GLOB ?
      ORDER BY event_key
    `).all(`codex:file:${fixture.sourceHash}:*:usage`);
    const scopedPrompts = store.db.prepare(`
      SELECT event_key, session_id
      FROM model_usage_prompt_events
      WHERE event_key GLOB ?
      ORDER BY event_key
    `).all(`codex:file:${fixture.sourceHash}:*:prompt`);

    assert.deepEqual(scopedUsage.map((row) => [
      row.event_key,
      row.session_id,
      row.total_tokens
    ]), [[expectedUsageKey, fixture.childSessionId, 67]]);
    assert.deepEqual(scopedPrompts.map((row) => [
      row.event_key,
      row.session_id
    ]), [[expectedPromptKey, fixture.childSessionId]]);
    assert.equal(result.records, 1);
    assert.equal(result.prompts, 1);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM model_usage_records WHERE event_key = ?'
    ).get(legacy.legacyUsageKey).count, 0);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM model_usage_prompt_events WHERE event_key = ?'
    ).get(legacy.legacyPromptKey).count, 0);
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS count FROM model_usage_records WHERE event_key = 'codex:file:0123456789abcdef:9:usage'"
    ).get().count, 1);
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS count FROM model_usage_prompt_events WHERE event_key = 'codex:file:0123456789abcdef:8:prompt'"
    ).get().count, 1);
    const rebuiltSession = store.db.prepare(`
      SELECT project, cwd, git_branch, started_at_ms, updated_at_ms, prompt_count
      FROM model_usage_sessions
      WHERE provider = 'codex' AND session_id = ?
    `).get(fixture.childSessionId);
    assert.deepEqual([
      rebuiltSession.project,
      rebuiltSession.cwd,
      rebuiltSession.git_branch,
      rebuiltSession.started_at_ms,
      rebuiltSession.updated_at_ms,
      rebuiltSession.prompt_count
    ], [
      'child',
      '/work/child',
      '',
      Date.parse('2026-07-16T06:08:42.998Z'),
      Date.parse('2026-07-16T06:08:57.318Z'),
      1
    ]);
    assert.equal(store.getFileState(fixture.filePath).scanContext.codexScanContextVersion, 2);
  } finally {
    store.close();
  }
});

test('Codex fork reindex rolls back rows, session, and file state when the final state write fails', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const fixture = createForkFixture(t);
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(path.dirname(fixture.filePath), '.ai_home'),
    DatabaseSync
  });
  assert.ok(store);
  try {
    seedLegacyForkProjection(store, fixture);
    const before = readProjectionSnapshot(store, fixture);
    store.db.exec(`
      CREATE TRIGGER fail_codex_reindex_file_state
      BEFORE UPDATE ON model_usage_file_state
      BEGIN
        SELECT RAISE(ABORT, 'forced_file_state_failure');
      END
    `);

    assert.throws(
      () => scannerPrivate.scanCodexFile({
        fs,
        path,
        store,
        filePath: fixture.filePath,
        reindexCodexForkHistory: true
      }),
      /forced_file_state_failure/
    );

    assert.deepEqual(readProjectionSnapshot(store, fixture), before);
  } finally {
    store.close();
  }
});

test('a truncated legacy Codex fork stays deferred until atomic reindex replaces its rows', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const fixture = createForkFixture(t);
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(path.dirname(fixture.filePath), '.ai_home'),
    DatabaseSync
  });
  assert.ok(store);
  try {
    const legacy = seedLegacyForkProjection(store, fixture);
    const legacyOffset = fixture.fileSize + 4096;
    store.setFileState(fixture.filePath, {
      size: legacyOffset,
      offset: legacyOffset,
      scanContext: {
        sessionId: fixture.childSessionId,
        cwd: '/work/legacy',
        model: 'gpt-5.6-sol'
      }
    });

    const deferred = scannerPrivate.scanCodexFile({
      fs,
      path,
      store,
      filePath: fixture.filePath
    });

    assert.equal(deferred.records, 0);
    assert.equal(deferred.prompts, 0);
    assert.equal(deferred.reindexRequired, 1);
    assert.equal(store.getFileState(fixture.filePath).offset, legacyOffset);
    assert.equal(store.getFileState(
      fixture.filePath
    ).scanContext.codexScanContextVersion, undefined);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM model_usage_records WHERE event_key = ?'
    ).get(legacy.legacyUsageKey).count, 1);

    const rebuilt = scannerPrivate.scanCodexFile({
      fs,
      path,
      store,
      filePath: fixture.filePath,
      reindexCodexForkHistory: true
    });
    const expectedUsageKey = scannerPrivate.buildFileEventKey(
      'codex', fixture.filePath, fixture.offsets[6], 'usage'
    );

    assert.equal(rebuilt.records, 1);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM model_usage_records WHERE event_key = ?'
    ).get(legacy.legacyUsageKey).count, 0);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM model_usage_records WHERE event_key = ?'
    ).get(expectedUsageKey).count, 1);
    assert.equal(store.getFileState(fixture.filePath).offset, fixture.fileSize);
    assert.equal(store.getFileState(
      fixture.filePath
    ).scanContext.codexScanContextVersion, 2);
  } finally {
    store.close();
  }
});

test('ordinary Codex increments preserve logical prompts that have no event timestamp', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const sessionId = '019f698a-a7b0-7041-b4a2-41cfb5f0de49';
  const filePath = withTempFile(t, `${[
    JSON.stringify({
      timestamp: '2026-07-16T06:08:42.998Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/work/incremental' }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'user_message', message: 'prompt without timestamp' }
    })
  ].join('\n')}\n`);
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(path.dirname(filePath), '.ai_home'),
    DatabaseSync
  });
  assert.ok(store);
  try {
    const result = scannerPrivate.scanCodexFile({ fs, path, store, filePath });
    const session = store.db.prepare(`
      SELECT prompt_count
      FROM model_usage_sessions
      WHERE provider = 'codex' AND session_id = ?
    `).get(sessionId);

    assert.equal(result.prompts, 0);
    assert.equal(session.prompt_count, 1);
  } finally {
    store.close();
  }
});

test('file projection replacement rejects a valid hash belonging to another path', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const fixture = createForkFixture(t);
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(path.dirname(fixture.filePath), '.ai_home'),
    DatabaseSync
  });
  assert.ok(store);
  try {
    seedLegacyForkProjection(store, fixture);
    const mismatchedHash = '0123456789abcdef';
    assert.notEqual(mismatchedHash, fixture.sourceHash);
    const before = readProjectionSnapshot(store, fixture);

    assert.throws(
      () => store.replaceFileProjection({
        provider: 'codex',
        sourceHash: mismatchedHash,
        filePath: fixture.filePath,
        usageRecords: [],
        promptEvents: [],
        sessionRecords: [],
        fileState: { size: 1, offset: 1, scanContext: {} }
      }),
      /model_usage_file_projection_scope_invalid/
    );
    assert.deepEqual(readProjectionSnapshot(store, fixture), before);
  } finally {
    store.close();
  }
});
