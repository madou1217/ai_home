'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  projectCodexSessionHistory,
  readCodexSessionHistory
} = require('../lib/server/chat-runtime/codex-session-history');

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
