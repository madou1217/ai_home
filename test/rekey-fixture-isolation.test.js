'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/rekey-fixture');

test('concurrent maintenance fixtures do not impersonate the same native account', t => {
  const first = fixture(t);
  const second = fixture(t);
  // OS runtime guards deliberately recognize accountRef outside a fixture root.
  // Reusing a fixed synthetic identity made parallel test subprocesses look like
  // a live writer for another test's migration. Isolate identities, not the guard.
  assert.notEqual(first.ref, second.ref);
  const firstPlan = first.plan();
  const secondPlan = second.plan();
  assert.notEqual(firstPlan.mapping[0][1], secondPlan.mapping[0][1]);
  assert.deepEqual(firstPlan.blockers, []);
  assert.deepEqual(secondPlan.blockers, []);
});
