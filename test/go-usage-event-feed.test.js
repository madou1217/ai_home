const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeApiUsageByFormat } = require('../lib/usage/model-usage-api-record');
const {
  SOURCE_KIND,
  createGoUsageEventFeed,
  toAnthropicUsage
} = require('../lib/server/go-usage-event-feed');

function goEvent(seq, overrides = {}) {
  return {
    seq,
    account_ref: 'go_1',
    model: 'gpt-5.5',
    at_ms: 1_790_000_000_000 + seq,
    input_tokens: 1000,
    cached_input_tokens: 700,
    cache_write_input_tokens: 100,
    output_tokens: 50,
    reasoning_tokens: 20,
    total_tokens: 1050,
    ...overrides
  };
}

test('Canonical Go usage converts to Anthropic parts without changing the total', () => {
  const usage = toAnthropicUsage(goEvent(1));
  assert.deepEqual(usage, {
    input_tokens: 200,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 700,
    output_tokens: 50
  });
  assert.equal(normalizeApiUsageByFormat('anthropic', 'codex', usage).totalTokens, 1050);
});

test('feed records each Go event once through the shared usage entry, resuming by cursor', async () => {
  const pages = new Map([
    [0, { boot_id: 'b1', latest_seq: 2, data: [goEvent(1), goEvent(2)] }],
    [2, { boot_id: 'b1', latest_seq: 3, data: [goEvent(3)] }],
    [3, { boot_id: 'b1', latest_seq: 3, data: [] }]
  ]);
  const requested = [];
  const recorded = [];
  const feed = createGoUsageEventFeed({
    listUsageEvents: async (after) => { requested.push(after); return pages.get(after) || null; },
    readGoRefsByNodeRef: () => ({ acct_node_b: 'go_1', acct_node_a: 'go_1' }),
    resolveProvider: (nodeRef) => (nodeRef === 'acct_node_a' ? 'codex' : ''),
    recordUsage: (payload) => { recorded.push(payload); return 1; }
  });

  assert.equal(await feed.poll(), 2);
  assert.equal(await feed.poll(), 1);
  assert.equal(await feed.poll(), 0);
  assert.deepEqual(requested, [0, 2, 3]);
  assert.deepEqual(recorded.map((payload) => payload.eventKey), ['go:b1:1', 'go:b1:2', 'go:b1:3']);
  const first = recorded[0];
  assert.equal(first.accountRef, 'acct_node_a', 'merged Node accounts attribute to one stable ref');
  assert.equal(first.provider, 'codex');
  assert.equal(first.usageFormat, 'anthropic');
  assert.equal(first.sourceKind, SOURCE_KIND);
  assert.equal(first.timestampMs, 1_790_000_000_001);
});

test('feed restarts from seq 0 when Go reboots, and skips unlinked or unknown accounts', async () => {
  let boot = 'b1';
  const recorded = [];
  const feed = createGoUsageEventFeed({
    listUsageEvents: async (after) => {
      if (boot === 'b1') return { boot_id: 'b1', latest_seq: 5, data: after < 5 ? [goEvent(5)] : [] };
      // 新进程序号从 1 开始：旧游标 5 会漏掉，必须从 0 重读。
      return { boot_id: 'b2', latest_seq: 2, data: [goEvent(1), goEvent(2, { account_ref: 'go_unlinked' })].filter((event) => event.seq > after) };
    },
    readGoRefsByNodeRef: () => null,
    resolveProvider: (nodeRef) => (nodeRef === 'go_1' ? 'claude' : ''),
    recordUsage: (payload) => { recorded.push(payload.eventKey); return 1; }
  });
  await feed.poll();
  boot = 'b2';
  await feed.poll();
  assert.deepEqual(recorded, ['go:b1:5', 'go:b2:1']);
  assert.deepEqual(feed.cursor(), { bootId: 'b2', seq: 2 });
});

test('Go outage keeps the cursor and records nothing', async () => {
  let down = false;
  const feed = createGoUsageEventFeed({
    listUsageEvents: async () => (down ? null : { boot_id: 'b1', latest_seq: 1, data: [goEvent(1)] }),
    resolveProvider: () => 'codex',
    recordUsage: () => 1
  });
  await feed.poll();
  down = true;
  assert.equal(await feed.poll(), 0);
  assert.deepEqual(feed.cursor(), { bootId: 'b1', seq: 1 });
});

test('stop performs a final poll so drained requests are still accounted', async () => {
  let polls = 0;
  const feed = createGoUsageEventFeed({
    listUsageEvents: async () => { polls += 1; return { boot_id: 'b1', latest_seq: 0, data: [] }; },
    resolveProvider: () => 'codex',
    recordUsage: () => 1
  });
  feed.start(60_000);
  await feed.stop();
  assert.equal(polls, 1);
});
