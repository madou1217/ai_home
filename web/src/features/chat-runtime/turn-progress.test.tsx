import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionProjection, SessionProjectionStore } from '@/chat-runtime';
import { selectTimelinePresentation } from './timeline-presentation';
import TurnProgress from './TurnProgress';

test('progress follows the active reasoning/answer and ignores previous turn output', () => {
  const projection = { state: 'running', activeTurn: { turnId: 'active', state: 'running' }, items: [
    { id: 'old', turnId: 'old', kind: 'message', status: 'completed', detail: { role: 'assistant' } },
    { id: 'thought', turnId: 'active', kind: 'reasoning', status: 'running', content: 'thinking', detail: {} },
  ] } as unknown as SessionProjection;
  assert.equal(selectTimelinePresentation(projection).progressItemId, 'thought');
  const answering = { ...projection, items: [...projection.items,
    { id: 'answer', turnId: 'active', kind: 'message', status: 'running', detail: { role: 'assistant' } }] } as SessionProjection;
  assert.equal(selectTimelinePresentation(answering).progressItemId, 'answer');
  assert.equal(selectTimelinePresentation({ ...answering, state: 'idle', activeTurn: undefined }).progressItemId, undefined);
  const hidden = { ...projection, items: [{ ...projection.items[1], content: '', status: 'completed' }] } as SessionProjection;
  assert.equal(selectTimelinePresentation(hidden).progressItemId, undefined);
  assert.equal(selectTimelinePresentation(hidden).items.length, 0);
});

test('refresh reads the persisted start and first token instead of starting a new timer', () => {
  const now = Date.now();
  const snapshot = { sessionId: 's1', state: 'running', items: [],
    activeTurn: { turnId: 'active', startedAt: now - 12000, firstTokenAt: now - 10500 } };
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {} } as unknown as SessionProjectionStore;
  const html = renderToStaticMarkup(<TurnProgress store={store} />);
  assert.match(html, /12秒/);
  assert.match(html, /首字 1.5秒/);
  assert.doesNotMatch(html, /停止|已用时/);
});
