import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoResolutionState,
  autoResolutionSubmission,
  createAutoResolutionSchedule,
} from './question-auto-resolution-policy';

test('inactivity countdown uses only the canonical inactivity and countdown durations', () => {
  const schedule = createAutoResolutionSchedule({
    mode: 'inactivity_countdown', inactivityMs: 60_000, countdownMs: 60_000,
    onExpire: 'submit_empty', snooze: 'disable',
  }, 1_000);

  assert.deepEqual(schedule, {
    countdownAt: 61_000,
    expiresAt: 121_000,
  });
  assert.deepEqual(autoResolutionState(schedule, 2_000, false), { phase: 'grace' });
});

test('direct countdown starts immediately and can be snoozed by policy', () => {
  const schedule = createAutoResolutionSchedule({
    mode: 'countdown', countdownMs: 5_000,
    onExpire: 'decline', snooze: 'restart',
  }, 1_000);
  assert.ok(schedule);

  assert.deepEqual(autoResolutionState(schedule, 1_000, false), {
    phase: 'countdown', remainingMs: 5_000,
  });
  assert.deepEqual(autoResolutionState(schedule, 1_001, true), { phase: 'snoozed' });
  assert.deepEqual(autoResolutionState(schedule, schedule.expiresAt, false), { phase: 'expired' });
});

test('missing canonical policy disables auto resolution without defaults', () => {
  assert.equal(createAutoResolutionSchedule(undefined, 1_000), null);
});

test('auto resolution preserves submit-empty and decline as distinct commands', () => {
  assert.deepEqual(autoResolutionSubmission('submit_empty'), {
    action: 'submit', answer: {},
  });
  assert.deepEqual(autoResolutionSubmission('decline'), { action: 'decline' });
});
