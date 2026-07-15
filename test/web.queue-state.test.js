const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadQueueState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'queue-state.js'
  )).href;
  return import(modulePath);
}

test('resolveQueuedMode keeps codex oauth on after_tool_call and other modes on after_turn', async () => {
  const { resolveQueuedMode } = await loadQueueState();

  assert.equal(resolveQueuedMode('codex', false), 'after_tool_call');
  assert.equal(resolveQueuedMode('codex', true), 'after_turn');
  assert.equal(resolveQueuedMode('claude', false), 'after_turn');
});

test('appendQueuedMessage and removeQueuedMessage keep queue items scoped to one session key', async () => {
  const { appendQueuedMessage, prependQueuedMessage, removeQueuedMessage } = await loadQueueState();

  const state1 = appendQueuedMessage({}, 'codex:s1:p1', { id: 'q1', content: 'first' });
  const state2 = appendQueuedMessage(state1, 'codex:s1:p1', { id: 'q2', content: 'second' });
  const state3 = appendQueuedMessage(state2, 'gemini:s2:p1', { id: 'q3', content: 'other' });
  const state4 = prependQueuedMessage(state3, 'codex:s1:p1', { id: 'q0', content: 'urgent' });
  const state5 = removeQueuedMessage(state4, 'codex:s1:p1', 'q1');

  assert.deepEqual(state5, {
    'codex:s1:p1': [
      { id: 'q0', content: 'urgent' },
      { id: 'q2', content: 'second' }
    ],
    'gemini:s2:p1': [{ id: 'q3', content: 'other' }]
  });
});

test('shiftQueuedMessageByMode extracts the matching queued item without disturbing the rest order', async () => {
  const { shiftQueuedMessageByMode } = await loadQueueState();

  const result = shiftQueuedMessageByMode({
    'codex:s1:p1': [
      { id: 'q1', mode: 'after_turn', content: 'later' },
      { id: 'q2', mode: 'after_tool_call', content: 'tool-boundary' },
      { id: 'q3', mode: 'after_turn', content: 'last' }
    ]
  }, 'codex:s1:p1', 'after_tool_call');

  assert.deepEqual(result.shifted, { id: 'q2', mode: 'after_tool_call', content: 'tool-boundary' });
  assert.deepEqual(result.nextState, {
    'codex:s1:p1': [
      { id: 'q1', mode: 'after_turn', content: 'later' },
      { id: 'q3', mode: 'after_turn', content: 'last' }
    ]
  });
});

test('moveQueuedMessages transfers draft-run queues onto the real session run key', async () => {
  const { moveQueuedMessages } = await loadQueueState();

  const result = moveQueuedMessages({
    'draft:session': [
      { id: 'q1', content: 'first' },
      { id: 'q2', content: 'second' }
    ],
    'codex:s1:p1': [
      { id: 'q3', content: 'existing' }
    ]
  }, 'draft:session', 'codex:s1:p1');

  assert.deepEqual(result, {
    'codex:s1:p1': [
      { id: 'q3', content: 'existing' },
      { id: 'q1', content: 'first' },
      { id: 'q2', content: 'second' }
    ]
  });
});

test('moveQueuedMessageToFront promotes the target queued message without losing the rest order', async () => {
  const { moveQueuedMessageToFront } = await loadQueueState();

  const result = moveQueuedMessageToFront({
    'codex:s1:p1': [
      { id: 'q1', content: 'first' },
      { id: 'q2', content: 'second' },
      { id: 'q3', content: 'third' }
    ]
  }, 'codex:s1:p1', 'q3');

  assert.deepEqual(result.moved, { id: 'q3', content: 'third' });
  assert.deepEqual(result.nextState, {
    'codex:s1:p1': [
      { id: 'q3', content: 'third' },
      { id: 'q1', content: 'first' },
      { id: 'q2', content: 'second' }
    ]
  });
});
