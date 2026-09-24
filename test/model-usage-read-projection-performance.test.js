const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __private: modelUsageReadProjectionPrivate
} = require('../lib/usage/model-usage-read-projection');

function createCandidate(scannerId, proxyId, deltaMs = 0) {
  return {
    scannerId,
    proxyId,
    scannerTimestampMs: scannerId,
    deltaMs,
    sessionRank: 0
  };
}

test('observation matching partitions disconnected candidate graphs', () => {
  assert.equal(
    typeof modelUsageReadProjectionPrivate.partitionObservationCandidates,
    'function'
  );

  const components = modelUsageReadProjectionPrivate.partitionObservationCandidates([
    createCandidate(2, 11, 20),
    createCandidate(1, 10, 10),
    createCandidate(2, 10, 30),
    createCandidate(3, 12, 5)
  ]);

  assert.deepEqual(
    components.map((component) => (
      component.map(({ scannerId, proxyId }) => [scannerId, proxyId])
    )),
    [
      [[3, 12]],
      [[1, 10], [2, 11], [2, 10]]
    ]
  );
});

test('observation matching keeps large disconnected ranges inside the read budget', () => {
  const candidates = Array.from({ length: 12_000 }, (_, index) => (
    createCandidate(index + 1, index + 100_001, index % 1_000)
  ));
  const startedAt = performance.now();

  const matches = modelUsageReadProjectionPrivate.matchObservationCandidates(candidates);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(matches.length, candidates.length);
  assert.deepEqual(
    matches.map(({ scannerId, proxyId }) => [scannerId, proxyId]),
    candidates
      .slice()
      .sort((left, right) => (
        left.deltaMs - right.deltaMs || left.scannerTimestampMs - right.scannerTimestampMs
      ))
      .map(({ scannerId, proxyId }) => [scannerId, proxyId])
  );
  assert.ok(elapsedMs < 2_000, `disconnected matching took ${Math.round(elapsedMs)}ms`);
});

test('scanner candidates seek each proxy window instead of scanning every usage record', (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE model_usage_records (
      id INTEGER PRIMARY KEY, event_key TEXT, provider TEXT, session_id TEXT,
      source_kind TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      reasoning_output_tokens INTEGER, total_tokens INTEGER, cost_usd REAL,
      timestamp_ms INTEGER, project TEXT, cwd TEXT, git_branch TEXT
    );
    CREATE INDEX idx_model_usage_timestamp ON model_usage_records(timestamp_ms);
    INSERT INTO model_usage_records (
      id, event_key, provider, session_id, source_kind, model,
      input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
      cost_usd, timestamp_ms, project, cwd, git_branch
    ) VALUES
      (1, 'near', 'codex', 'one', 'session_jsonl', 'gpt-5', 10, 5, 2, 3, 1, 21, 0, 9000, '', '', ''),
      (2, 'far', 'codex', 'two', 'session_jsonl', 'gpt-5', 10, 5, 2, 3, 1, 21, 0, 12000, '', '', ''),
      (3, 'late', 'codex', 'three', 'session_jsonl', 'gpt-5', 10, 5, 2, 3, 1, 21, 0, 10000, '', '', ''),
      (4, 'proxy', 'codex', 'one', 'server_codex_proxy', 'gpt-5', 10, 5, 2, 3, 1, 21, 0, 10000, '', '', '');
  `);
  let candidateSql = '';
  const observedDatabase = {
    prepare(sql) {
      candidateSql = sql;
      return database.prepare(sql);
    }
  };
  const proxies = [{
    id: 4,
    timestamp_ms: 10000,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
    reasoning_output_tokens: 1
  }];

  const candidates = modelUsageReadProjectionPrivate.readScannerCandidates(
    observedDatabase, proxies, { recordHighWaterId: 2 }
  );
  assert.deepEqual(candidates.map(({ id, proxy_id }) => [id, proxy_id]), [[1, 4]]);

  const plan = database.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all(
    JSON.stringify([{
      id: 4, timestampMs: 10000, contextTokens: 15,
      outputTokens: 5, generationTokens: 6
    }]), 1000, 1000, 2
  ).map((step) => step.detail);
  assert.ok(plan.some((step) => /SEARCH s USING INDEX idx_model_usage_timestamp \(timestamp_ms>\? AND timestamp_ms<\?\)/.test(step)), plan.join('\n'));
  assert.ok(!plan.some((step) => /SCAN s USING INDEX/.test(step)), plan.join('\n'));
});
