'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isDiscardedBranchTurn, retainBranchTurns } = require('../lib/server/chat-runtime/codex-work-branch');

test('Work branch drops only explicit stale or rollback turns', () => {
  const stale = { id: 'stale', status: 'stale', items: [] };
  const rollback = { id: 'rollback', status: 'rolled-back', items: [] };
  const flagged = { id: 'flagged', status: 'completed', rolledBack: true, items: [] };
  const completed = { id: 'completed', status: 'completed', items: [] };
  const unknown = { id: 'future', status: 'future_status', items: [] };

  assert.equal(isDiscardedBranchTurn(stale), true);
  assert.equal(isDiscardedBranchTurn(rollback), true);
  assert.equal(isDiscardedBranchTurn(flagged), true);
  assert.equal(isDiscardedBranchTurn(completed), false);
  assert.equal(isDiscardedBranchTurn(unknown), false);
  assert.deepEqual(retainBranchTurns([stale, rollback, flagged, completed, unknown]), [completed, unknown]);
});

test('malformed branch entries fail closed instead of becoming child history', () => {
  assert.equal(isDiscardedBranchTurn(null), true);
  assert.deepEqual(retainBranchTurns([null, [], { id: 'ok', status: 'completed' }]), [{ id: 'ok', status: 'completed' }]);
});
