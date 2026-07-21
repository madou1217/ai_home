import type {
  InteractionAnswer,
  QuestionAutoResolution,
  QuestionAutoResolutionExpiration,
} from '@/chat-runtime';

export interface AutoResolutionSchedule {
  readonly countdownAt: number;
  readonly expiresAt: number;
}

export type AutoResolutionState =
  | { readonly phase: 'disabled' | 'grace' | 'snoozed' | 'expired' }
  | { readonly phase: 'countdown'; readonly remainingMs: number };

export type AutoResolutionSubmission =
  | { readonly action: 'submit'; readonly answer: InteractionAnswer }
  | { readonly action: 'decline' };

export function autoResolutionSubmission(
  outcome: QuestionAutoResolutionExpiration,
): AutoResolutionSubmission {
  return outcome === 'submit_empty'
    ? { action: 'submit', answer: {} }
    : { action: 'decline' };
}

export function createAutoResolutionSchedule(
  policy: QuestionAutoResolution | undefined,
  startedAt: number,
): AutoResolutionSchedule | null {
  if (!policy) return null;
  const inactivityMs = policy.mode === 'inactivity_countdown' ? policy.inactivityMs : 0;
  const countdownAt = startedAt + inactivityMs;
  return { countdownAt, expiresAt: countdownAt + policy.countdownMs };
}

export function autoResolutionState(
  schedule: AutoResolutionSchedule | null,
  now: number,
  snoozed: boolean,
): AutoResolutionState {
  if (!schedule) return { phase: 'disabled' };
  if (snoozed) return { phase: 'snoozed' };
  if (now >= schedule.expiresAt) return { phase: 'expired' };
  if (now < schedule.countdownAt) return { phase: 'grace' };
  return { phase: 'countdown', remainingMs: schedule.expiresAt - now };
}
