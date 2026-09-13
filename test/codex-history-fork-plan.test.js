'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { planCodexHistoryFork } = require('../lib/server/chat-runtime/codex-history-fork-plan');

function fixture() {
  const call = { id: 'call', type: 'function_call', call_id: 'a', name: 'exec', arguments: '{}' };
  const output = { id: 'output', type: 'function_call_output', call_id: 'a', output: [
    { type: 'input_image', image_url: 'data:image/png;base64,AA', detail: 'original' }] };
  return { threadId: 'source', itemId: 'middle', coverage: 'complete', response: { thread: { id: 'source', turns: [
    { id: 'old', status: 'completed', items: [{ id: 'old-summary', type: 'contextCompaction' }] },
    { id: 'selected', status: 'completed', items: [
      { id: 'user-visible-id', type: 'userMessage' }, { id: 'middle', type: 'agentMessage' },
      { id: 'later-tool', type: 'commandExecution' }, { id: 'final', type: 'agentMessage' }] },
    { id: 'later', status: 'completed', items: [{ id: 'unrelated', type: 'agentMessage' }] }
  ] } }, rawTurn: [
    { id: 'user-raw-id', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'request' }] },
    { id: 'reasoning', type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    call, output,
    { id: 'middle', type: 'message', role: 'assistant', phase: 'commentary', content: [
      { type: 'output_text', text: 'selected answer' }] },
    { ...call, id: 'later-tool', call_id: 'b' }, { ...output, id: 'later-output', call_id: 'b' },
    { id: 'final', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'later answer' }] }
  ] };
}

test('complete turn forks natively while a middle message injects only the exact raw prefix', () => {
  const input = fixture();
  const whole = planCodexHistoryFork({ ...input, itemId: 'final' });
  assert.deepEqual(whole, { threadId: 'source', lastTurnId: 'selected', items: [], sourceItemId: 'final' });
  const partial = planCodexHistoryFork(input);
  assert.equal(partial.beforeTurnId, 'selected');
  assert.equal(partial.lastTurnId, undefined);
  assert.deepEqual(partial.items, input.rawTurn.slice(0, 5));
  assert.doesNotMatch(JSON.stringify(partial), /later-tool|later answer/);
  partial.items[0].content[0].text = 'mutated';
  assert.equal(input.rawTurn[0].content[0].text, 'request');
});

test('a typed final message never rounds past a tool omitted by legacy history', () => {
  const input = fixture();
  input.response.thread.turns[1].items = input.response.thread.turns[1].items.slice(0, 2);
  const plan = planCodexHistoryFork(input);
  assert.equal(plan.beforeTurnId, 'selected');
  assert.equal(plan.lastTurnId, undefined);
  assert.deepEqual(plan.items, input.rawTurn.slice(0, 5));
  assert.throws(() => planCodexHistoryFork({ ...input, coverage: null }), /raw_history_incomplete/);
});

test('native whole-turn forks keep opaque native items without attempting raw conversion', () => {
  const input = fixture();
  input.rawTurn.splice(1, 0, { id: 'native-compaction', type: 'context_compaction', encrypted_content: 'opaque' });
  assert.deepEqual(planCodexHistoryFork({ ...input, itemId: 'final' }), {
    threadId: 'source', lastTurnId: 'selected', items: [], sourceItemId: 'final'
  });
  assert.throws(() => planCodexHistoryFork(input), /raw_item_unsupported/);
});

test('message identity, raw capture gaps and unfinished native turns fail closed', () => {
  const input = fixture();
  assert.throws(() => planCodexHistoryFork({ ...input, threadId: 'foreign' }), /thread_mismatch/);
  assert.throws(() => planCodexHistoryFork({ ...input, itemId: 'missing' }), /identity_unavailable/);
  for (const coverage of [null, 'recording', 'incomplete']) {
    assert.throws(() => planCodexHistoryFork({ ...input, coverage }), /raw_history_incomplete/);
  }
  assert.throws(() => planCodexHistoryFork({ ...input, itemId: 'user-visible-id' }), /raw_message_identity_unavailable/);
  input.response.thread.turns[1].status = 'inProgress';
  assert.throws(() => planCodexHistoryFork(input), /turn_not_completed/);
});

test('partial turns reject unknown raw types and tool calls that cross the exact message cut', () => {
  const input = fixture();
  input.rawTurn.splice(3, 1);
  assert.throws(() => planCodexHistoryFork(input), /cut_has_pending_tools/);
  input.rawTurn[2] = { id: 'unknown', type: 'future_type' };
  assert.throws(() => planCodexHistoryFork(input), /raw_item_unsupported/);
  const mismatch = fixture();
  mismatch.rawTurn[3].call_id = 'another-call';
  assert.throws(() => planCodexHistoryFork(mismatch), /tool_pair_invalid/);
  const duplicate = fixture();
  duplicate.rawTurn.splice(4, 0, { ...duplicate.rawTurn[2], id: 'different-id' });
  assert.throws(() => planCodexHistoryFork(duplicate), /tool_pair_invalid/);
});
