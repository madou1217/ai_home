import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  QuestionAutoResolution,
  QuestionAutoResolutionExpiration,
} from '@/chat-runtime';
import {
  autoResolutionState,
  createAutoResolutionSchedule,
} from './question-auto-resolution-policy';
import type {
  AutoResolutionSchedule,
  AutoResolutionState,
} from './question-auto-resolution-policy';

interface Options {
  readonly policy?: QuestionAutoResolution;
  readonly ready: boolean;
  readonly requestKey: string;
  readonly onExpire: (
    outcome: QuestionAutoResolutionExpiration,
  ) => boolean | Promise<boolean>;
}

interface QuestionAutoResolutionControl {
  readonly state: AutoResolutionState;
  readonly remainingSeconds?: number;
  readonly snooze: () => void;
}

interface AutoResolutionTimerDriver {
  readonly now: () => number;
  readonly setInterval: (callback: () => void, delayMs: number) => number;
  readonly clearInterval: (timerId: number) => void;
}

interface AutoResolutionClock {
  readonly schedule: AutoResolutionSchedule | null;
  readonly now: number;
  readonly pausedAt: number | null;
}

type AutoResolutionAttemptState = 'idle' | 'submitting' | 'completed';

export class AutoResolutionAttemptGate {
  private state: AutoResolutionAttemptState = 'idle';

  constructor(private requestKey: string) {}

  reset(requestKey: string): void {
    if (requestKey === this.requestKey) return;
    this.requestKey = requestKey;
    this.state = 'idle';
  }

  begin(requestKey: string): boolean {
    if (requestKey !== this.requestKey || this.state !== 'idle') return false;
    this.state = 'submitting';
    return true;
  }

  settle(requestKey: string, succeeded: boolean): boolean {
    if (requestKey !== this.requestKey || this.state !== 'submitting') return false;
    this.state = succeeded ? 'completed' : 'idle';
    return true;
  }
}

const AUTO_RESOLUTION_TICK_MS = 250;
const browserTimerDriver: AutoResolutionTimerDriver = {
  now: () => Date.now(),
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: (timerId) => window.clearInterval(timerId),
};

export function useQuestionAutoResolution({
  policy,
  ready,
  requestKey,
  onExpire,
}: Options): QuestionAutoResolutionControl {
  const [clock, setClock] = useState<AutoResolutionClock>(() => (
    createAutoResolutionClock(policy, Date.now(), ready)
  ));
  const [snoozed, setSnoozed] = useState(false);
  const expireRef = useRef(onExpire);
  const policyRef = useRef(policy);
  const readyRef = useRef(ready);
  const requestKeyRef = useRef(requestKey);
  const mountedRef = useRef(false);
  const attemptGateRef = useRef<AutoResolutionAttemptGate | null>(null);
  if (!attemptGateRef.current) {
    attemptGateRef.current = new AutoResolutionAttemptGate(requestKey);
  }
  expireRef.current = onExpire;
  policyRef.current = policy;
  readyRef.current = ready;
  requestKeyRef.current = requestKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const startedAt = Date.now();
    attemptGateRef.current?.reset(requestKey);
    setSnoozed(false);
    setClock(createAutoResolutionClock(policyRef.current, startedAt, readyRef.current));
  }, [requestKey]);

  useEffect(() => {
    const changedAt = Date.now();
    setClock((current) => ready
      ? resumeAutoResolutionClock(current, changedAt)
      : pauseAutoResolutionClock(current, changedAt));
  }, [ready]);

  useEffect(() => {
    if (!ready || !clock.schedule || snoozed) return;
    return startAutoResolutionInterval(clock.schedule, (observedAt) => {
      setClock((current) => advanceAutoResolutionClock(current, observedAt));
    });
  }, [clock.schedule, ready, snoozed]);

  const state = autoResolutionClockState(clock, ready, snoozed);
  useEffect(() => {
    const gate = attemptGateRef.current;
    if (!ready || !policy || state.phase !== 'expired' || !gate?.begin(requestKey)) return;
    void resolveAutoResolution(expireRef.current, policy.onExpire).then((succeeded) => {
      if (
        !mountedRef.current
        || requestKeyRef.current !== requestKey
        || !gate.settle(requestKey, succeeded)
      ) return;
      if (succeeded) return;
      const restartedAt = Date.now();
      setClock(createAutoResolutionClock(
        policyRef.current,
        restartedAt,
        readyRef.current,
      ));
    });
  }, [policy, ready, requestKey, state.phase]);

  const snooze = useCallback(() => {
    if (!policy) return;
    if (policy.snooze === 'disable') {
      setSnoozed(true);
      return;
    }
    const restartedAt = Date.now();
    setSnoozed(false);
    setClock(createAutoResolutionClock(policy, restartedAt, readyRef.current));
  }, [policy]);

  return {
    state,
    ...(state.phase === 'countdown'
      ? { remainingSeconds: Math.ceil(state.remainingMs / 1000) }
      : {}),
    snooze,
  };
}

function createAutoResolutionClock(
  policy: QuestionAutoResolution | undefined,
  startedAt: number,
  ready: boolean,
): AutoResolutionClock {
  return {
    schedule: createAutoResolutionSchedule(policy, startedAt),
    now: startedAt,
    pausedAt: ready ? null : startedAt,
  };
}

export function pauseAutoResolutionClock(
  clock: AutoResolutionClock,
  pausedAt: number,
): AutoResolutionClock {
  if (clock.pausedAt !== null) return clock;
  return { ...clock, now: pausedAt, pausedAt };
}

export function resumeAutoResolutionClock(
  clock: AutoResolutionClock,
  resumedAt: number,
): AutoResolutionClock {
  if (clock.pausedAt === null) return clock;
  const pausedFor = Math.max(0, resumedAt - clock.pausedAt);
  return {
    schedule: shiftAutoResolutionSchedule(clock.schedule, pausedFor),
    now: resumedAt,
    pausedAt: null,
  };
}

export function advanceAutoResolutionClock(
  clock: AutoResolutionClock,
  observedAt: number,
): AutoResolutionClock {
  return clock.pausedAt === null ? { ...clock, now: observedAt } : clock;
}

export function autoResolutionClockState(
  clock: AutoResolutionClock,
  ready: boolean,
  snoozed: boolean,
): AutoResolutionState {
  return autoResolutionState(clock.schedule, clock.now, snoozed || !ready);
}

function shiftAutoResolutionSchedule(
  schedule: AutoResolutionSchedule | null,
  delayMs: number,
): AutoResolutionSchedule | null {
  return schedule && {
    countdownAt: schedule.countdownAt + delayMs,
    expiresAt: schedule.expiresAt + delayMs,
  };
}

async function resolveAutoResolution(
  onExpire: Options['onExpire'],
  outcome: QuestionAutoResolutionExpiration,
): Promise<boolean> {
  try {
    return await onExpire(outcome);
  } catch (_error) {
    return false;
  }
}

export function startAutoResolutionInterval(
  schedule: AutoResolutionSchedule,
  onTick: (now: number) => void,
  driver: AutoResolutionTimerDriver = browserTimerDriver,
): () => void {
  let active = true;
  let timer = 0;
  const stop = () => {
    if (!active) return;
    active = false;
    driver.clearInterval(timer);
  };
  timer = driver.setInterval(() => {
    const now = driver.now();
    onTick(now);
    if (now >= schedule.expiresAt) stop();
  }, AUTO_RESOLUTION_TICK_MS);
  return stop;
}
