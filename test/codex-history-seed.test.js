'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readCodexHistorySeed } = require('../lib/server/chat-runtime/codex-history-seed');

const user = { id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Keep COBALT' },
  { type: 'image', url: 'data:image/png;base64,cHJvYmU=', detail: 'high' }] };
const answer = { id: 'answer', type: 'agentMessage', text: 'COBALT', phase: 'final_answer' };
function client(items) {
  return { async request() { return { thread: { id: 'thread', turns: [
    { id: 'previous', status: 'completed', items },
    { id: 'failed', status: 'failed', items: [{ ...answer, id: 'failed-answer', text: 'do not replay' }] }
  ] } }; } };
}

test('overflow seed preserves typed messages, image detail and private reasoning; excludes failed turn', async () => {
  const raw = { id: 'reasoning', type: 'reasoning', summary: [], encrypted_content: 'opaque' };
  const seed = await readCodexHistorySeed(client([user, { id: 'reasoning', type: 'reasoning', summary: [] }, answer]),
    'thread', { excludeTurnId: 'failed', readNativeItem: () => raw });
  assert.deepEqual(seed, [
    { id: 'input', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep COBALT' },
      { type: 'input_image', image_url: user.content[1].url, detail: 'high' }] },
    raw, { id: 'answer', type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'COBALT' }] }
  ]);
});

test('overflow refuses missing native evidence instead of discarding it and retrying an empty thread', async () => {
  for (const item of [{ id: 'reasoning', type: 'reasoning', summary: [] },
    { id: 'tool', type: 'commandExecution' }, { id: 'compact', type: 'contextCompaction' }]) {
    await assert.rejects(readCodexHistorySeed(client([user, item, answer]), 'thread', { excludeTurnId: 'failed' }),
      /codex_history_seed_unsupported/);
  }
});

test('overflow retains injected branch seed omitted by typed turns without duplicating overlapping ids', async () => {
  const inherited = { type: 'message', id: 'inherited-input', role: 'user',
    content: [{ type: 'input_text', text: 'Original branch marker' }] };
  const inheritedAnswer = { type: 'message', id: 'inherited-answer', role: 'assistant',
    content: [{ type: 'output_text', text: 'Original branch answer' }] };
  const seed = await readCodexHistorySeed(client([
    { id: 'inherited-answer', type: 'agentMessage', text: 'Original branch answer' }, user, answer
  ]), 'thread', { excludeTurnId: 'failed', initialHistory: [inherited, inheritedAnswer] });
  assert.equal(seed.length, 4);
  assert.deepEqual(seed.slice(0, 2), [inherited, inheritedAnswer]);
});
