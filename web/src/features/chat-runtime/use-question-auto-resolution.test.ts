import assert from 'node:assert/strict';
import test from 'node:test';
import { autoResolutionState } from './question-auto-resolution-policy';
import {
  AutoResolutionAttemptGate,
  advanceAutoResolutionClock,
  autoResolutionClockState,
  pauseAutoResolutionClock,
  resumeAutoResolutionClock,
  startAutoResolutionInterval,
} from './use-question-auto-resolution';

test('disconnected auto-resolution clock does not consume time or expire', () => {
  const paused = pauseAutoResolutionClock({
    schedule: { countdownAt: 0, expiresAt: 1_000 },
    now: 250,
    pausedAt: null,
  }, 250);

  const afterDisconnect = advanceAutoResolutionClock(paused, 10_000);

  assert.equal(afterDisconnect, paused);
  assert.deepEqual(autoResolutionClockState(afterDisconnect, false, false), {
    phase: 'snoozed',
  });
});

test('reconnected auto-resolution clock preserves the exact remaining duration', () => {
  const paused = pauseAutoResolutionClock({
    schedule: { countdownAt: 0, expiresAt: 1_000 },
    now: 250,
    pausedAt: null,
  }, 250);

  const resumed = resumeAutoResolutionClock(paused, 5_250);

  assert.deepEqual(resumed, {
    schedule: { countdownAt: 5_000, expiresAt: 6_000 },
    now: 5_250,
    pausedAt: null,
  });
  assert.deepEqual(
    autoResolutionState(resumed.schedule, resumed.now, false),
    { phase: 'countdown', remainingMs: 750 },
  );
  const expired = advanceAutoResolutionClock(resumed, 6_000);
  assert.deepEqual(
    autoResolutionState(expired.schedule, expired.now, false),
    { phase: 'expired' },
  );
});

test('failed auto-resolution attempt unlocks the same request for retry', () => {
  const gate = new AutoResolutionAttemptGate('question-1:1');

  assert.equal(gate.begin('question-1:1'), true);
  gate.settle('question-1:1', false);

  assert.equal(gate.begin('question-1:1'), true);
});

test('successful auto-resolution attempt remains deduplicated for the same request', () => {
  const gate = new AutoResolutionAttemptGate('question-1:1');

  assert.equal(gate.begin('question-1:1'), true);
  gate.settle('question-1:1', true);

  assert.equal(gate.begin('question-1:1'), false);
  gate.reset('question-1:2');
  assert.equal(gate.begin('question-1:2'), true);
});

test('same logical request cannot reset an in-flight or completed attempt', () => {
  const gate = new AutoResolutionAttemptGate('question-1:1');

  assert.equal(gate.begin('question-1:1'), true);
  gate.reset('question-1:1');
  assert.equal(gate.begin('question-1:1'), false);
  gate.settle('question-1:1', true);
  gate.reset('question-1:1');

  assert.equal(gate.begin('question-1:1'), false);
});

test('auto-resolution interval stops immediately when the schedule expires', () => {
  let currentTime = 999;
  let tick: (() => void) | undefined;
  const clearedTimers: number[] = [];
  const observedTimes: number[] = [];
  const stop = startAutoResolutionInterval(
    { countdownAt: 0, expiresAt: 1_000 },
    (now: number) => observedTimes.push(now),
    {
      now: () => currentTime,
      setInterval: (callback: () => void, delayMs: number) => {
        assert.equal(delayMs, 250);
        tick = callback;
        return 7;
      },
      clearInterval: (timerId: number) => clearedTimers.push(timerId),
    },
  );

  assert.ok(tick);
  tick();
  assert.deepEqual(clearedTimers, []);

  currentTime = 1_000;
  tick();
  assert.deepEqual(observedTimes, [999, 1_000]);
  assert.deepEqual(clearedTimers, [7]);

  stop();
  assert.deepEqual(clearedTimers, [7]);
});
