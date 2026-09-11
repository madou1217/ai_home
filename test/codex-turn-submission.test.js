'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { submitCodexTurn, uncertainSubmissionError } = require('../lib/server/chat-runtime/codex-turn-submission');
const { terminalResult } = require('../lib/server/chat-runtime/turn-settlement');

const disconnected = () => Object.assign(new Error('socket closed'), { code: 'codex_app_server_disconnected' });

test('lost submission receipt waits for exact recovery without making another request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = {};
  let requests = 0;
  let settled = false;
  const pending = submitCodexTurn({ active, params: { clientUserMessageId: 'run' },
    client: {
      async request(method, params) {
        requests += 1;
        assert.equal(method, 'turn/start');
        assert.equal(params.clientUserMessageId, 'run');
        throw disconnected();
      },
      async waitForReconnect() { await gate; active.persistedNativeTurnId = 'original'; return true; }
    }, anchor() { throw new Error('recovery owns the anchor'); }
  }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.submissionUncertain, true);
  assert.equal(settled, false);
  release();
  await pending;
  assert.equal(requests, 1);
});

for (const mode of ['no-reconnect-api', 'not-reconnecting', 'missing-anchor']) {
  test(`submission uncertainty is explicit when recovery is ${mode}`, async () => {
    const failure = disconnected();
    const client = { request: async () => { throw failure; } };
    if (mode !== 'no-reconnect-api') client.waitForReconnect = async () => mode === 'missing-anchor';
    await assert.rejects(submitCodexTurn({ client, active: {} }), (error) => (
      error.code === 'codex_turn_start_outcome_unknown'
      && error.outcomeUnknown === true && error.cause === failure
    ));
  });
}

test('a definitive RPC rejection remains a normal failure and does not trigger recovery', async () => {
  const failure = Object.assign(new Error('invalid model'), { code: 'codex_app_server_rpc_error' });
  await assert.rejects(submitCodexTurn({ active: {}, client: {
    request: async () => { throw failure; },
    waitForReconnect() { throw new Error('rejected input must not reconnect'); }
  } }), (error) => error === failure && error.outcomeUnknown === undefined);
});

test('an accepted turn receipt is not exposed until its native anchor is persisted', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = {};
  let settled = false;
  const pending = submitCodexTurn({ active, client: { request: async () => ({ turn: { id: 'native' } }) },
    anchor: async (run, id) => { assert.equal(run, active); assert.equal(id, 'native'); await gate; }
  }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await pending;
});

test('a stop intent cannot mask an unresolved execution outcome as a successful cancellation', () => {
  const result = terminalResult({ interruptRequested: true, submissionCommandId: 'input' }, null,
    uncertainSubmissionError(disconnected()));
  assert.equal(result.type, 'turn.failed');
  assert.equal(result.payload.outcomeUnknown, true);
  assert.equal(result.payload.retryable, false);
});
