'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  patchCodexThreadTurnModelsResponse
} = require('../lib/server/codex-turn-model-metadata');

test('Codex thread model projector preserves per-turn model changes without guessing', () => {
  const response = JSON.stringify({
    id: 'read-1',
    result: {
      thread: {
        id: 'thread-1',
        turns: [
          { id: 'turn-1', items: [] },
          { id: 'turn-2', items: [] },
          { id: 'turn-without-model', items: [] }
        ]
      }
    }
  });
  const rollout = [
    turnContext('turn-1', 'gpt-5.3-codex'),
    turnContext('turn-2', 'gpt-5.4-codex')
  ].join('\n');

  const patched = patchCodexThreadTurnModelsResponse(response, {
    threadId: 'thread-1',
    rolloutPath: '/rollout.jsonl'
  }, {
    fs: { readFileSync: () => rollout }
  });
  const turns = JSON.parse(patched).result.thread.turns;

  assert.equal(turns[0].model, 'gpt-5.3-codex');
  assert.equal(turns[1].model, 'gpt-5.4-codex');
  assert.equal(Object.hasOwn(turns[2], 'model'), false);
});

test('Codex thread model projector leaves foreign responses untouched', () => {
  const response = JSON.stringify({
    id: 'read-1',
    result: { thread: { id: 'thread-2', turns: [{ id: 'turn-1', items: [] }] } }
  });
  const patched = patchCodexThreadTurnModelsResponse(response, {
    threadId: 'thread-1',
    rolloutPath: '/rollout.jsonl'
  }, {
    fs: { readFileSync: () => turnContext('turn-1', 'gpt-5.3-codex') }
  });

  assert.equal(patched, response);
});

function turnContext(turnId, model) {
  return JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, model } });
}
