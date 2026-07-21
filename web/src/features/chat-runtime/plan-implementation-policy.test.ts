import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionProjection, TimelineItem } from '@/chat-runtime';
import { resolvePlanImplementationPrompt } from './plan-implementation-policy';

test('offers implementation only for the latest completed proposed plan in Plan mode', () => {
  const projection = fixture({
    policy: { approvalMode: 'plan' },
    items: [message('turn-1', 'question'), plan('turn-1', 'Inspect\nImplement')],
  });

  assert.deepEqual(resolvePlanImplementationPrompt(projection), {
    turnId: 'turn-1',
    planItemId: 'plan-turn-1',
    planMarkdown: 'Inspect\nImplement',
  });
});

test('does not offer an old plan after a newer turn or an update_plan checklist', () => {
  const olderPlan = plan('turn-1', 'Old plan');
  const newerMessage = message('turn-2', 'Continue planning');
  const checklist = {
    ...plan('turn-2', 'Checklist'),
    detail: { steps: [{ step: 'Run tests', status: 'completed' as const }] },
  };

  assert.equal(resolvePlanImplementationPrompt(fixture({
    policy: { approvalMode: 'plan' }, items: [olderPlan, newerMessage],
  })), undefined);
  assert.equal(resolvePlanImplementationPrompt(fixture({
    policy: { approvalMode: 'plan' }, items: [olderPlan, checklist],
  })), undefined);
});

test('suppresses the prompt for queues, interactions, non-idle state, and dismissed turns', () => {
  const base = { policy: { approvalMode: 'plan' }, items: [plan('turn-1', 'Plan')] };
  assert.equal(resolvePlanImplementationPrompt(fixture({ ...base, state: 'running' })), undefined);
  assert.equal(resolvePlanImplementationPrompt(fixture({
    ...base,
    queue: [{ status: 'queued' } as SessionProjection['queue'][number]],
  })), undefined);
  assert.equal(resolvePlanImplementationPrompt(fixture({
    ...base,
    interactions: [{} as SessionProjection['interactions'][number]],
  })), undefined);
  assert.equal(resolvePlanImplementationPrompt(fixture({
    ...base,
    policy: { approvalMode: 'plan', planConfirmationDismissedTurnId: 'turn-1' },
  })), undefined);
});

function fixture(
  overrides: Partial<SessionProjection> = {},
): SessionProjection {
  return {
    sessionId: 'session-1',
    connectionState: 'connected',
    state: 'idle',
    throughSeq: 1,
    policy: {},
    queue: [],
    interactions: [],
    items: [],
    timelineHasMore: false,
    timelineNextBefore: null,
    ...overrides,
  };
}

function plan(
  turnId: string,
  content: string,
): Extract<TimelineItem, { kind: 'plan' }> {
  return {
    id: `plan-${turnId}`,
    turnId,
    kind: 'plan',
    createdAt: 1,
    status: 'completed',
    content,
    detail: { state: 'proposed' },
  };
}

function message(turnId: string, content: string): TimelineItem {
  return {
    id: `message-${turnId}`,
    turnId,
    kind: 'message',
    createdAt: 1,
    status: 'completed',
    content,
    detail: { role: 'assistant' },
  };
}
