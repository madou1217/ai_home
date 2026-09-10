import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionProjection, TimelineItem } from '@/chat-runtime';
import { reasoningText, selectTimelinePresentation } from './timeline-presentation';

test('screenshot regression: many empty reasoning events render only current activity', () => {
  const items = [
    message('user', 'user'),
    ...Array.from({ length: 9 }, (_, i) => reasoning(`stale-${i}`, 'running')),
    ...Array.from({ length: 12 }, (_, i) => reasoning(`done-${i}`, 'completed')),
    reasoning('current', 'running'),
  ];
  const before = structuredClone(items);
  const result = selectTimelinePresentation(projection(items));

  assert.deepEqual(result.items.map(({ id }) => id), ['user', 'current']);
  assert.equal(result.runningReasoningId, 'current');
  assert.deepEqual(items, before);
});

test('visible summaries keep their order around tools and messages without stale running badges', () => {
  const items: TimelineItem[] = [
    reasoning('first', 'running', 'first summary'),
    { id: 'tool', kind: 'tool', status: 'completed', createdAt: 1, detail: { name: 'search' } },
    reasoning('second', 'completed', 'second summary'),
    message('answer', 'assistant'),
    reasoning('current', 'running', 'streaming summary'),
  ];
  const result = selectTimelinePresentation(projection(items));
  assert.deepEqual(result.items, items);
  assert.equal(result.runningReasoningId, 'current');
  assert.equal(selectTimelinePresentation(projection(items.slice(0, 4))).runningReasoningId, undefined);
});

test('terminal, interrupted, lost, and recovering sessions never retain an empty thinking indicator', () => {
  for (const state of ['idle', 'closed', 'interrupting', 'completing', 'recovering', 'waiting_input'] as const) {
    const result = selectTimelinePresentation({ ...projection([reasoning('current', 'running')]), state });
    assert.deepEqual(result.items, []);
    assert.equal(result.runningReasoningId, undefined);
  }
  const failed = selectTimelinePresentation({
    ...projection([reasoning('current', 'running')]),
    streamFailure: { eventId: 'failure', error: 'lost', message: 'lost', retryable: false },
  });
  assert.deepEqual(failed.items, []);
});

test('empty failure and cancellation remain visible without a running label', () => {
  const items = [reasoning('failed', 'failed'), reasoning('cancelled', 'cancelled')];
  const result = selectTimelinePresentation(projection(items));
  assert.deepEqual(result.items, items);
  assert.equal(result.runningReasoningId, undefined);
});

test('history reload tolerates missing turn ids but rejects an explicitly different turn', () => {
  const current = reasoning('current', 'running');
  assert.equal(selectTimelinePresentation(projection([current])).runningReasoningId, current.id);
  const other = { ...current, turnId: 'old-turn' };
  assert.deepEqual(selectTimelinePresentation(projection([other])).items, []);
  assert.deepEqual(selectTimelinePresentation({ ...projection([current]), activeTurn: undefined }).items, []);
});

test('streaming content replaces the activity placeholder and survives completion and reload', () => {
  const current = reasoning('current', 'running');
  const streaming = { ...current, content: 'visible summary' };
  const complete = { ...streaming, status: 'completed' as const };
  for (const item of [current, streaming, complete]) {
    assert.equal(selectTimelinePresentation(projection([item])).items[0], item);
  }
  const reloaded = selectTimelinePresentation({ ...projection([complete]), state: 'idle', activeTurn: undefined });
  assert.equal(reloaded.items[0].content, 'visible summary');
  assert.equal(reloaded.runningReasoningId, undefined);
  assert.deepEqual(selectTimelinePresentation(projection([{ ...current, status: 'completed' }])).items, []);
});

test('whitespace content falls back to the public summary without manufacturing reasoning', () => {
  const item = { ...reasoning('reason', 'completed', ' \n '), detail: { summary: 'public summary' } };
  assert.equal(reasoningText(item), 'public summary');
  assert.deepEqual(selectTimelinePresentation(projection([item])).items, [item]);
});

test('latest failed turn has one inline failure with retry while older errors remain in history', () => {
  const oldError: TimelineItem = { id: 'old-error', turnId: 'old-turn', kind: 'error',
    status: 'failed', content: 'old failure', createdAt: 1, detail: { code: 'old' } };
  const error: TimelineItem = { ...oldError, id: 'new-error', turnId: 'failed-turn' };
  const answer = { ...message('partial-answer', 'assistant'), turnId: 'failed-turn' };
  const result = selectTimelinePresentation({
    ...projection([oldError, answer, error]), state: 'idle', activeTurn: undefined,
    failedTurn: { turnId: 'failed-turn', retryable: true, error: { code: 'timeout', message: 'idle timeout' } },
  });
  assert.deepEqual(result.items.map(({ id }) => id), ['old-error', 'partial-answer']);
  const unanchored = { ...oldError, turnId: undefined };
  assert.deepEqual(selectTimelinePresentation(projection([unanchored])).items, [unanchored]);
});

function reasoning(id: string, status: TimelineItem['status'], content = ''): Extract<TimelineItem, { kind: 'reasoning' }> {
  return { id, kind: 'reasoning', status, content, createdAt: 1, detail: { segments: [] } };
}

function message(id: string, role: 'user' | 'assistant'): TimelineItem {
  return { id, kind: 'message', status: 'completed', content: id, createdAt: 1, detail: { role } };
}

function projection(items: readonly TimelineItem[]): SessionProjection {
  return {
    sessionId: 'session', state: 'running', connectionState: 'connected', throughSeq: 1,
    activeTurn: { turnId: 'active-turn', state: 'running' },
    items, policy: {}, queue: [], interactions: [], timelineHasMore: false, timelineNextBefore: null,
  };
}
