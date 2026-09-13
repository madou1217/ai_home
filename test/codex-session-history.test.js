'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  projectCodexSessionHistory,
  readCodexSessionHistory,
  readPagedTurns,
  hydrateCodexHistoryResponse
} = require('../lib/server/chat-runtime/codex-session-history');

test('complete captured typed identities override rewritten legacy IDs; recovery gaps retain the native view', () => {
  const response = { thread: { id: 'thread', turns: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 2,
    items: [{ id: 'legacy-rewritten', type: 'agentMessage', text: 'answer' }] }] } };
  const options = { threadId: 'thread', readNativeThreadItems: () => [{ item: {
    id: 'exact-live', type: 'agentMessage', text: 'answer'
  } }], readNativeCoverage: () => 'complete' };
  assert.deepEqual(projectCodexSessionHistory(response, options).events.map((event) => event.itemId), ['exact-live']);
  assert.deepEqual(projectCodexSessionHistory(response, { ...options, readNativeCoverage: () => 'incomplete' })
    .events.map((event) => event.itemId), ['legacy-rewritten']);
});

test('Codex history reader requests complete typed turns from the native thread', async () => {
  const calls = [];
  const client = {
    async ensureConnected() { calls.push(['connect']); },
    async request(method, params) {
      calls.push([method, params]);
      return historyResponse();
    }
  };

  const result = await readCodexSessionHistory(client, 'thread-1', {
    runtimeId: 'codex:account-1'
  });

  assert.deepEqual(calls, [
    ['connect'],
    ['thread/read', { threadId: 'thread-1', includeTurns: true }]
  ]);
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.events.length, 4);
});

test('Codex history reader falls back to paginated full turns on newer app-servers', async () => {
  const calls = [];
  const client = {
    async ensureConnected() {},
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/read') {
        const error = new Error('list_turns is not supported yet');
        error.code = 'codex_app_server_rpc_error';
        throw error;
      }
      const page = calls.filter(([name]) => name === 'thread/turns/list').length;
      return page === 1
        ? { data: [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2,
          items: [{ id: 'answer-1', type: 'agentMessage', text: 'one' }] }], nextCursor: 'next' }
        : { data: [{ id: 'turn-2', status: 'completed', startedAt: 3, completedAt: 4,
          items: [{ id: 'answer-2', type: 'agentMessage', text: 'two' }] }], nextCursor: null };
    }
  };

  const result = await readCodexSessionHistory(client, 'thread-paged');
  assert.deepEqual(calls, [
    ['thread/read', { threadId: 'thread-paged', includeTurns: true }],
    ['thread/turns/list', { threadId: 'thread-paged', limit: 100, sortDirection: 'asc', itemsView: 'full' }],
    ['thread/turns/list', { threadId: 'thread-paged', cursor: 'next', limit: 100, sortDirection: 'asc', itemsView: 'full' }]
  ]);
  assert.deepEqual(result.events.map((event) => event.payload.item.content), ['one', 'two']);
});

test('Codex history reader hydrates metadata-only thread reads through full turn pages', async () => {
  const calls = [];
  const client = { async request(method, params) {
    calls.push([method, params]);
    if (method === 'thread/read') return {
      thread: { id: 'thread-summary', turns: [{ id: 'summary-turn', itemsView: 'summary', items: [] }] },
      turnsBackwardsCursor: 'cursor'
    };
    return { data: [{ id: 'summary-turn', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ id: 'answer', type: 'agentMessage', text: 'hydrated' }] }], nextCursor: null };
  } };
  const result = await readCodexSessionHistory(client, 'thread-summary');
  assert.equal(calls[1][0], 'thread/turns/list');
  assert.equal(result.events[0].payload.item.content, 'hydrated');
});

test('Codex history hydration replaces recent summaries with full tools, not just older pages', async () => {
  const calls = [];
  const client = { async request(method, params) {
    calls.push([method, params]);
    if (method === 'thread/read') return {
      thread: { id: 'thread-merge', turns: [{ id: 'recent', items_view: 'summary',
        items: [{ id: 'recent-answer', type: 'agentMessage', text: 'recent' }] }] },
      turns_backwards_cursor: 'older'
    };
    assert.equal(params.cursor, undefined, 'older cursor cannot hydrate the recent summary');
    return { data: [fullTurn('older'), fullTurn('recent', [
      { id: 'tool', type: 'commandExecution', command: 'pwd', cwd: '/repo',
        status: 'completed', aggregatedOutput: '/repo', exitCode: 0 },
      { id: 'recent-answer', type: 'agentMessage', text: 'recent' }
    ])], next_cursor: null };
  } };
  const result = await readCodexSessionHistory(client, 'thread-merge');
  assert.deepEqual(result.events.map((event) => event.payload.item.content), ['older', '/repo', 'recent']);
  assert.equal(calls[1][1].sortDirection, 'asc');
});

test('full recent turns merge with an inclusive backwards anchor exactly once', async () => {
  const response = { thread: { id: 'thread-1', turns: [fullTurn('anchor'), fullTurn('recent')] },
    turnsBackwardsCursor: 'turn-anchor' };
  const client = { async request(method, params) {
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.cursor, 'turn-anchor');
    assert.equal(params.sortDirection, 'desc');
    return { data: [fullTurn('anchor'), fullTurn('older')], nextCursor: null };
  } };
  const hydrated = await hydrateCodexHistoryResponse(client, response, { threadId: 'thread-1' });
  assert.deepEqual(hydrated.thread.turns.map((turn) => turn.id), ['older', 'anchor', 'recent']);
  assert.equal(hydrated.turnsBackwardsCursor, undefined);
  assert.equal(await hydrateCodexHistoryResponse({ request() { assert.fail('already hydrated'); } },
    hydrated, { threadId: 'thread-1' }), hydrated);
});

test('item cursors never enter the turn API; initial page summaries are fully hydrated', async () => {
  const response = { thread: { id: 'thread-1', turns: [] }, itemsBackwardsCursor: 'item-cursor',
    initialTurnsPage: { data: [{ ...fullTurn('native-turn'), itemsView: 'summary', items: [] }],
      nextCursor: null } };
  const client = { async request(method, params) {
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.cursor, undefined);
    return { data: [fullTurn('native-turn')], nextCursor: null };
  } };
  const hydrated = await hydrateCodexHistoryResponse(client, response, { threadId: 'thread-1' });
  assert.equal(hydrated.thread.turns[0].items[0].text, 'native-turn');
  assert.equal(hydrated.itemsBackwardsCursor, undefined);
  assert.equal(hydrated.initialTurnsPage, undefined);
});

test('summary hydration refuses to silently retain a turn missing from full pages', async () => {
  const response = { thread: { id: 'thread-1', turns: [{ ...fullTurn('missing'), itemsView: 'summary' }] } };
  await assert.rejects(hydrateCodexHistoryResponse({ async request() { return { data: [], nextCursor: null }; } },
    response, { threadId: 'thread-1' }), /codex_history_incomplete/);
});

test('paginated durable turns preserve unflushed live tools and correlate provisional user ids', async () => {
  const user = { type: 'userMessage', id: 'temporary', clientId: 'input-1', content: [] };
  const tool = { type: 'commandExecution', id: 'shell', status: 'inProgress' };
  const response = { thread: { id: 'thread-1', turns: [fullTurn('turn-1', [user, tool])] },
    itemsBackwardsCursor: 'item-cursor' };
  const durable = fullTurn('turn-1', [{ ...user, id: 'durable' }]);
  const client = { async request() { return { data: [durable], nextCursor: null }; } };
  const hydrated = await hydrateCodexHistoryResponse(client, response, { threadId: 'thread-1' });
  assert.deepEqual(hydrated.thread.turns[0].items.map((item) => item.id), ['durable', 'shell']);
  durable.items.push({ ...tool, status: 'completed' });
  const completed = await hydrateCodexHistoryResponse(client, response, { threadId: 'thread-1' });
  assert.equal(completed.thread.turns[0].items[1].status, 'completed');
});

test('foreign paginated thread is rejected before any history RPC', async () => {
  const client = { async request(method) {
    assert.equal(method, 'thread/read', 'must not read history for foreign identity');
    return { thread: { id: 'foreign', turns: [] }, turnsBackwardsCursor: 'foreign-cursor' };
  } };
  await assert.rejects(readCodexSessionHistory(client, 'thread-1'), /codex_history_thread_mismatch/);
});

test('pagination continues across empty pages with a next cursor and enforces its page limit', async () => {
  let calls = 0;
  const client = { async request() {
    return ++calls === 1 ? { data: [], nextCursor: 'after-empty' }
      : { data: [fullTurn('last')], nextCursor: null };
  } };
  assert.deepEqual((await readPagedTurns(client, 'thread-1')).map((turn) => turn.id), ['last']);
  calls = 0;
  await assert.rejects(readPagedTurns(client, 'thread-1', { maxPages: 1 }), /codex_history_pagination_limit/);
  assert.equal(calls, 1);
});

test('pagination rejects malformed, partial, unidentified and duplicate turns', async () => {
  for (const page of [null, {}, { turns: [] }, { data: 'invalid' },
    { data: [{ items: [] }] }, { data: [{ id: 'missing-items' }] },
    { data: [{ ...fullTurn('summary'), itemsView: 'summary' }] },
    { data: [fullTurn('duplicate'), fullTurn('duplicate')] }]) {
    await assert.rejects(readPagedTurns({ async request() { return page; } }, 'thread-1'),
      /codex_history_(page|turn|incomplete)/);
  }
});

test('Codex paginated history rejects a repeated cursor instead of looping', async () => {
  let calls = 0;
  const client = { async request() {
    calls += 1;
    return { data: [{ id: `turn-${calls}`, status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ id: `answer-${calls}`, type: 'agentMessage', text: 'x' }] }], nextCursor: 'same' };
  } };
  await assert.rejects(() => readPagedTurns(client, 'thread-loop'),
    (error) => error.code === 'codex_history_pagination_loop');
  assert.equal(calls, 2);
});

test('Codex paginated history accepts snake_case cursor and turn payload fields', async () => {
  const client = { async request() {
    return { data: [{ id: 'turn-snake', status: 'completed', started_at: 1, completed_at: 2,
      items: [{ id: 'answer-snake', type: 'agentMessage', text: 'snake' }] }], next_cursor: '' };
  } };
  const result = await readPagedTurns(client, 'thread-snake');
  assert.equal(result[0].id, 'turn-snake');
  const projected = projectCodexSessionHistory({ thread: { id: 'thread-snake', updated_at: 3, turns: result } },
    { threadId: 'thread-snake' });
  assert.equal(projected.revision, 3);
  assert.equal(projected.events[0].at, 1000);
});

function fullTurn(id, items = [{ id: `${id}-answer`, type: 'agentMessage', text: id }]) {
  return { id, status: 'completed', itemsView: 'full', startedAt: 1, completedAt: 2, items };
}

test('Codex history projector keeps native turn identity private while preserving stable events', () => {
  const first = projectCodexSessionHistory(historyResponse(), {
    threadId: 'thread-1',
    runtimeId: 'codex:account-1'
  });
  const second = projectCodexSessionHistory(historyResponse(), {
    threadId: 'thread-1',
    runtimeId: 'codex:account-1'
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.events.map((event) => ({
    type: event.type,
    turnId: event.turnId,
    itemTurnId: event.payload.item.turnId,
    itemId: event.itemId,
    kind: event.payload.item.kind,
    content: event.payload.item.content,
    source: event.source
  })), [
    {
      type: 'timeline.item.completed', turnId: undefined, itemTurnId: undefined,
      itemId: 'user-1',
      kind: 'message', content: 'hello',
      source: { provider: 'codex', runtimeId: 'codex:account-1' }
    },
    {
      type: 'timeline.item.completed', turnId: undefined, itemTurnId: undefined,
      itemId: 'reason-1',
      kind: 'reasoning', content: 'checked',
      source: { provider: 'codex', runtimeId: 'codex:account-1' }
    },
    {
      type: 'timeline.item.completed', turnId: undefined, itemTurnId: undefined,
      itemId: 'shell-1',
      kind: 'shell', content: 'ok',
      source: { provider: 'codex', runtimeId: 'codex:account-1' }
    },
    {
      type: 'timeline.item.completed', turnId: undefined, itemTurnId: undefined,
      itemId: 'agent-1',
      kind: 'message', content: 'done',
      source: { provider: 'codex', runtimeId: 'codex:account-1' }
    }
  ]);
  assert.match(first.events[0].eventId, /^history-[a-f0-9]{64}$/);
  assert.equal(first.events[0].at, 1_000);
  assert.equal(first.events[0].payload.item.updatedAt, 2_000);
  assert.equal(first.events[0].payload.item.detail.model, 'gpt-5.3-codex');
  assert.equal(first.events[3].payload.item.detail.model, 'gpt-5.3-codex');
});

test('recovery maps only the exact native turn and keeps import IDs stable', () => {
  const response = historyResponse();
  response.thread.turns.push({ id: 'other-native-turn', status: 'completed', startedAt: 3, completedAt: 4,
    items: [{ id: 'other-answer', type: 'agentMessage', text: 'other answer' }] });
  const normal = projectCodexSessionHistory(response, { threadId: 'thread-1' });
  const anchored = projectCodexSessionHistory(response, { threadId: 'thread-1',
    recoveryAnchor: { nativeTurnId: 'turn-1', turnId: 'aih-turn' } });
  assert.deepEqual(anchored.events.map((event) => event.eventId), normal.events.map((event) => event.eventId));
  assert.ok(anchored.events.slice(0, 4).every((event) => event.turnId === 'aih-turn'
    && event.payload.item.turnId === 'aih-turn'));
  assert.equal(anchored.events.at(-1).turnId, undefined);
  assert.equal(anchored.events.at(-1).payload.item.turnId, undefined);
});

test('Codex history projector fails closed on a foreign or malformed thread', () => {
  assert.throws(
    () => projectCodexSessionHistory(historyResponse(), { threadId: 'thread-other' }),
    (error) => error.code === 'codex_history_thread_mismatch'
  );
  assert.throws(
    () => projectCodexSessionHistory({ thread: { id: 'thread-1', turns: [{}] } }, {
      threadId: 'thread-1'
    }),
    (error) => error.code === 'codex_history_turn_invalid'
  );
});

test('history in an active turn keeps persisted reasoning completed and explicit tools active', () => {
  const response = historyResponse();
  const turn = response.thread.turns[0];
  turn.status = 'inProgress';
  turn.completedAt = null;
  turn.items = [
    turn.items[0],
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `reason-${index}`, type: 'reasoning', summary: [], content: []
    })),
    { ...turn.items[2], status: 'inProgress' }
  ];

  const result = projectCodexSessionHistory(response, { threadId: 'thread-1' });

  assert.ok(result.events.slice(0, 10).every((event) => (
    event.type === 'timeline.item.completed' && event.payload.item.status === 'completed'
  )));
  assert.equal(result.events.at(-1).payload.item.status, 'running');
  assert.equal(result.events.at(-1).type, 'timeline.item.started');
});

test('Codex history projector preserves a native proposed plan as a plan item', () => {
  const result = projectCodexSessionHistory({
    thread: {
      id: 'thread-plan',
      updatedAt: 4,
      turns: [{
        id: 'turn-plan',
        status: 'completed',
        startedAt: 3,
        completedAt: 4,
        items: [{
          id: 'turn-plan-plan',
          type: 'plan',
          text: '# Implementation plan',
          steps: [{ step: 'Import the plan' }, { step: 'Render the choice' }]
        }]
      }]
    }
  }, { threadId: 'thread-plan', runtimeId: 'codex:account-1' });

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].payload.item, {
    id: 'turn-plan-plan',
    kind: 'plan',
    createdAt: 3_000,
    updatedAt: 4_000,
    status: 'completed',
    content: '# Implementation plan',
    detail: {
      state: 'proposed',
      steps: ['Import the plan', 'Render the choice']
    }
  });
});

function historyResponse() {
  return {
    thread: {
      id: 'thread-1',
      updatedAt: 2,
      turns: [{
        id: 'turn-1',
        model: 'gpt-5.3-codex',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
          { id: 'reason-1', type: 'reasoning', summary: ['checked'], content: [] },
          {
            id: 'shell-1', type: 'commandExecution', command: 'pwd', cwd: '/repo',
            status: 'completed', aggregatedOutput: 'ok', exitCode: 0
          },
          { id: 'agent-1', type: 'agentMessage', text: 'done' }
        ]
      }]
    }
  };
}
