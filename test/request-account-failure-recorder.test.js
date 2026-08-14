'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRequestAccountFailureRecorder
} = require('../lib/server/request-account-failure-recorder');

test('explicit failure does not commit sibling ambiguous failures before request finalization', () => {
  const applied = [];
  const recorder = createRequestAccountFailureRecorder((account, policy) => {
    applied.push([account.accountRef, policy.kind]);
  });
  const ambiguousPolicy = {
    kind: 'rate_limited',
    deferAccountFailureUntilRequestOutcome: true
  };

  recorder.record({ accountRef: 'ambiguous-1' }, ambiguousPolicy);
  recorder.record({ accountRef: 'capacity-account' }, { kind: 'model_capacity_unavailable' });
  recorder.record({ accountRef: 'ambiguous-2' }, ambiguousPolicy);

  assert.deepEqual(applied, [['capacity-account', 'model_capacity_unavailable']]);
  assert.deepEqual(recorder.finalize({ requestSucceeded: false }), {
    committed: 0,
    discarded: 2,
    discardedAccountRefs: ['ambiguous-1', 'ambiguous-2']
  });
  assert.deepEqual(applied, [['capacity-account', 'model_capacity_unavailable']]);
});

test('snapshot exposes only unresolved ambiguous failures for retry decisions', () => {
  const recorder = createRequestAccountFailureRecorder(() => {});
  const policy = { kind: 'rate_limited', deferAccountFailureUntilRequestOutcome: true };

  recorder.record({ accountRef: 'agy-1' }, policy);
  recorder.record({ accountRef: 'agy-2' }, policy);
  recorder.recordSuccess({ accountRef: 'agy-1' });

  assert.deepEqual(recorder.snapshot(), {
    pendingAccountRefs: ['agy-2'],
    immediateFailureRecorded: false
  });
});
