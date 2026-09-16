'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCodexQuotaFailure, codexQuotaRetryDelay, createResponseCommitGate, createResponseReplayLedger } = require('../lib/server/codex-response-recovery');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

for (const code of ['usage_limit_reached', 'insufficient_quota', 'rate_limit_exceeded', 'quota_exceeded']) {
  for (const envelope of ['http', 'ws', 'sse']) {
    test(`structured Codex quota ${code} via ${envelope} uses retry policy without auth poisoning`, () => {
      const error = { code, resets_in_seconds: 42 };
      const body = envelope === 'sse' ? { type: 'response.failed', response: { error } }
        : envelope === 'ws' ? { type: 'error', error } : { error };
      const policy = classifyUpstreamFailure({ provider: 'codex', body, statusCode: envelope === 'http' ? 429 : 0 });
      assert.equal(policy.kind, 'rate_limited');
      assert.equal(policy.cooldownMs, 42000);
      assert.equal(policy.scope, 'model');
      assert.equal(policy.shouldRetryAnotherAccount, true);
    });
  }
}

test('type-only native quota and absolute reset time are supported', () => {
  const result = getCodexQuotaFailure({ type: 'error', error: { type: 'usage_limit_reached', resets_at: 150 } });
  assert.equal(result.code, 'usage_limit_reached');
  assert.equal(codexQuotaRetryDelay(result, 100000), 50000);
});

test('quoted quota text or a successful response cannot trigger recovery', () => {
  for (const value of [null, [], 'usage_limit_reached',
    { type: 'response.output_text.delta', delta: 'usage_limit_reached' },
    { type: 'response.completed', response: { error: { code: 'usage_limit_reached' } } },
    { type: 'error', error: { message: "You've hit your usage limit." } }]) {
    assert.equal(getCodexQuotaFailure(value), null);
  }
});

test('Codex-specific envelope handling does not change other providers', () => {
  const policy = classifyUpstreamFailure({ provider: 'claude', statusCode: 400,
    body: { error: { code: 'usage_limit_reached', resets_in_seconds: 42 } } });
  assert.equal(policy.kind, 'invalid_request');
  assert.equal(policy.shouldRetryAnotherAccount, false);
});

test('only empty lifecycle preambles are delayed; semantic frames commit immediately', () => {
  const gate = createResponseCommitGate();
  assert.deepEqual(gate.push({ type: 'response.created', response: { output: [] } }, 'created'), []);
  assert.equal(gate.committed, false);
  assert.deepEqual(gate.push({ type: 'response.output_item.added' }, 'tool'), ['created', 'tool']);
  assert.equal(gate.committed, true);
  assert.deepEqual(gate.push({ type: 'response.in_progress' }, 'later'), ['later']);
});

for (const output of [[{ type: 'message' }], { unexpected: true }]) {
  test(`nonempty or malformed lifecycle output is not hidden: ${JSON.stringify(output)}`, () => {
    const gate = createResponseCommitGate();
    assert.deepEqual(gate.push({ type: 'response.created', response: { output } }, 'frame'), ['frame']);
    assert.equal(gate.committed, true);
  });
}

test('preamble buffering is byte/count bounded and preserves event order', () => {
  const gate = createResponseCommitGate(5);
  assert.deepEqual(gate.push({ type: 'response.created' }, '12345'), []);
  assert.deepEqual(gate.push({ type: 'response.created' }, '6'), ['12345', '6']);
  assert.equal(gate.committed, true);
  const many = createResponseCommitGate();
  for (let i = 0; i < 16; i++) assert.deepEqual(many.push({ type: 'response.created' }, 'x'), []);
  assert.equal(many.push({ type: 'response.created' }, 'y').length, 17);
});

test('public tool history is portable without ciphertext, ids or orphaned call results', () => {
  const ledger = createResponseReplayLedger();
  const initial = { input: 'edit one temporary file' };
  ledger.complete({ id: 'resp_1', output: [
    { type: 'reasoning', encrypted_content: 'private', id: 'rs_old' },
    { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: 'test patch', id: 'ctc_old' }
  ] }, ledger.expand(initial));
  const next = { type: 'response.create', model: 'same-model', previous_response_id: 'resp_1', input: [
    { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' }
  ] };
  const replay = ledger.replay(next, ledger.expand(next));
  assert.equal(replay.input.length, 3);
  assert.equal(replay.previous_response_id, undefined);
  assert.equal(JSON.stringify(replay).includes('private'), false);
  assert.equal(replay.input[1].id, undefined);
  assert.equal(next.previous_response_id, 'resp_1', 'never mutate client requests');
  assert.equal(ledger.expand({ previous_response_id: 'other', input: [] }), null);
});

test('opaque compaction/reference data and incomplete tool pairs disable replay', () => {
  for (const input of [
    [{ type: 'compaction', encrypted_content: 'opaque' }],
    [{ type: 'item_reference', id: 'old' }],
    [{ type: 'function_call_output', call_id: 'missing', output: 'x' }]
  ]) {
    const ledger = createResponseReplayLedger();
    assert.equal(ledger.replay({ input }, input), null);
  }
});

test('checkpoints remain connection-local and are dropped at size/depth limits', () => {
  const first = createResponseReplayLedger(128), other = createResponseReplayLedger();
  first.complete({ id: 'one', output: [] }, []);
  assert.deepEqual(first.expand({ previous_response_id: 'one', input: [] }), []);
  assert.equal(other.expand({ previous_response_id: 'one', input: [] }), null);
  assert.equal(first.expand({ input: 'x'.repeat(1000) }), null);
  let deeplyNested = {};
  for (let i = 0; i < 20000; i++) deeplyNested = { child: deeplyNested };
  assert.equal(first.expand({ input: [deeplyNested] }), null);
  first.clear();
  assert.equal(first.expand({ previous_response_id: 'one', input: [] }), null);
});
