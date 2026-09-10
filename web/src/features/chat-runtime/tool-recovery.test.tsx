import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseChatRuntimeEvent } from '@/chat-runtime/event-parser';
import { parseTimelineItem } from '@/chat-runtime/timeline-item-parser';
import { parseFailedTurn } from '@/chat-runtime/failed-turn-parser';
import { SessionProjectionStore } from '@/chat-runtime/session-projection-store';
import TimelineItemView from './TimelineItemView';
import { turnFailureMessage } from './turn-feedback-policy';

test('an unknown tool outcome renders a compact status without a running or success label', () => {
  const item = parseTimelineItem({ id: 'shell', kind: 'shell', status: 'unknown', createdAt: 1,
    detail: { command: 'write marker', output: 'partial output' } });
  const html = renderToStaticMarkup(<TimelineItemView item={item} provider="codex" projectPath="/tmp"
    onOpenFile={() => {}} />);
  assert.match(html, /结果未知/);
  assert.doesNotMatch(html, /运行中|data-tone="success"/);
  assert.match(html, /write marker/);
});

test('lost-run feedback and unknown tool state survive snapshot reset without enabling retry', () => {
  const store = new SessionProjectionStore('session', {
    request(callback) { callback(0); return { cancel() {} }; }, cancel(handle) { handle.cancel(); },
  });
  const item = parseTimelineItem({ id: 'shell', kind: 'shell', status: 'unknown', createdAt: 1,
    detail: { command: 'write marker' } });
  const snapshot = { sessionId: 'session', throughSeq: 0, state: 'running' as const,
    policy: {}, timeline: [item], queue: [], interactions: [], timelineHasMore: false, timelineNextBefore: null };
  store.reset(snapshot);
  store.apply(parseChatRuntimeEvent(JSON.stringify({ schema: 'aih.chat.event.v1', eventId: 'lost', sessionId: 'session',
    type: 'run.lost', turnId: 'turn', runId: 'run', seq: 1, at: 5,
    source: { provider: 'codex', runtimeId: 'probe' }, payload: { error: { code: 'native_gone' } } }), 'session'));
  const failure = parseFailedTurn(store.getSnapshot().failedTurn);
  assert.equal(failure.retryable, false);
  assert.equal(failure.outcomeUnknown, true);
  assert.match(turnFailureMessage(failure), /先核对实际结果/);
  store.reset({ ...snapshot, state: 'idle', throughSeq: 1, failedTurn: failure });
  assert.equal(store.getSnapshot().items[0].status, 'unknown');
  assert.deepEqual(store.getSnapshot().failedTurn, failure);
  store.dispose();
});
