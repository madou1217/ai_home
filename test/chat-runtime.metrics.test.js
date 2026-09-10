'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { mapCodexAppServerMessage } = require('../lib/server/codex-app-server-canonical');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-metrics-'));
  let now = 1000;
  const store = openChatRuntimeStore({ aiHomeDir: directory, clock: () => now });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sessionId = store.createSession({ provider: 'kimi', executionAccountRef: 'account-a' }).sessionId;
  const source = { provider: 'kimi', runtimeId: 'chat-test' };
  const append = (type, payload, turnId = 'turn-1') => store.appendEvent(sessionId, { type, turnId, source, payload });
  store.beginTurn(sessionId, { activeTurn: { turnId: 'turn-1', runId: 'run-1', startedAt: 1000, state: 'running' },
    event: { type: 'turn.queued', turnId: 'turn-1', source, payload: { state: 'running' } } });
  const output = (id, kind = 'message', content = '') => append('timeline.item.started', { item: {
    id, turnId: 'turn-1', kind, content, createdAt: now, status: 'running',
    detail: kind === 'message' ? { role: 'assistant', model: 'k3' } : {}
  } });
  const settle = (type = 'turn.completed') => store.settleTurn(sessionId, { event: {
    type, turnId: 'turn-1', source, payload: { state: 'idle' }
  } });
  return { store, sessionId, source, append, output, settle, time: (value) => { now = value; } };
}

test('turn metrics persist first visible output, aggregate usage and final duration across reload/import', (t) => {
  const f = fixture(t);
  f.output('thinking', 'reasoning');
  assert.equal(f.store.getSnapshot(f.sessionId).activeTurn.firstTokenAt, undefined);
  f.time(2500);
  f.append('timeline.item.delta', { itemId: 'thinking', chunk: 'thinking' });
  f.time(4000);
  f.output('answer', 'message', 'answer');
  f.append('turn.metrics.updated', { metrics: { inputTokens: 20, outputTokens: 30 }, totals: { inputTokens: 120, outputTokens: 130 } });
  f.append('turn.metrics.updated', { metrics: { inputTokens: 20, outputTokens: 30 }, totals: { inputTokens: 120, outputTokens: 130 } });
  f.append('turn.metrics.updated', { metrics: { inputTokens: 10, outputTokens: 40, contextTokens: 70, contextWindow: 1000 },
    totals: { inputTokens: 130, outputTokens: 170 } });
  assert.equal(f.store.getSnapshot(f.sessionId).activeTurn.firstTokenAt, 2500);
  f.time(8000);
  f.settle();
  const metrics = f.store.getSnapshot(f.sessionId).timeline.find((i) => i.id === 'answer').detail.metrics;
  assert.deepEqual(metrics, { inputTokens: 30, outputTokens: 70, contextTokens: 70, contextWindow: 1000,
    durationMs: 7000, ttftMs: 1500, tokensPerSec: 70 / 5.5 });
  assert.equal(f.store.getSnapshot(f.sessionId).timeline.find((i) => i.id === 'thinking').detail.metrics, undefined);
  f.store.importTimeline(f.sessionId, [{ eventId: 'native-import', type: 'timeline.item.completed', source: f.source,
    payload: { item: { id: 'answer', kind: 'message', content: 'answer', createdAt: 1000, updatedAt: 8000,
      status: 'completed', detail: { role: 'assistant' } } } }]);
  const restored = f.store.readTimeline(f.sessionId, { limit: 1 }).items[0];
  assert.deepEqual(restored.detail.metrics, metrics);
  assert.equal(restored.detail.model, 'k3');
  assert.equal(restored.turnId, 'turn-1');
});

test('another turn cannot contaminate timing or usage; cancellation never estimates missing tokens', (t) => {
  const f = fixture(t);
  f.output('answer');
  f.time(2000);
  f.append('turn.metrics.updated', { metrics: { outputTokens: 999 } }, 'old-turn');
  f.append('timeline.item.delta', { itemId: 'answer', chunk: 'foreign' }, 'old-turn');
  assert.equal(f.store.getSnapshot(f.sessionId).activeTurn.firstTokenAt, undefined);
  f.time(3000);
  f.append('timeline.item.delta', { itemId: 'answer', chunk: 'current' });
  f.time(5000);
  f.settle('turn.interrupted');
  const item = f.store.getSnapshot(f.sessionId).timeline.find((i) => i.id === 'answer');
  assert.equal(item.status, 'cancelled');
  assert.deepEqual(item.detail.metrics, { durationMs: 4000, ttftMs: 2000 });
});

test('native token usage maps last request and cumulative totals without exposing provider extras', () => {
  const event = mapCodexAppServerMessage({ method: 'thread/tokenUsage/updated', params: {
    turnId: 'native-1', tokenUsage: { last: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      total: { inputTokens: 40, outputTokens: 30 }, modelContextWindow: 1000, private: 'ignored' }
  } });
  assert.deepEqual(event, { type: 'turn.metrics.updated', turnId: 'native-1', payload: {
    metrics: { inputTokens: 20, outputTokens: 12, contextTokens: 32, contextWindow: 1000 },
    totals: { inputTokens: 40, outputTokens: 30 }
  } });
});

test('history import never invents first output timing and terminal metrics roll back atomically', (t) => {
  const f = fixture(t);
  f.output('answer');
  f.time(3000);
  f.store.importTimeline(f.sessionId, [{ eventId: 'history-active', type: 'timeline.item.completed', at: 1000,
    source: f.source, payload: { item: { id: 'answer', kind: 'message', content: 'restored',
      createdAt: 1000, status: 'completed', detail: { role: 'assistant' } } } }]);
  assert.equal(f.store.getSnapshot(f.sessionId).activeTurn.firstTokenAt, undefined);
  const before = f.store.getSnapshot(f.sessionId);
  assert.throws(() => f.settle('invalid.terminal'));
  assert.deepEqual(f.store.getSnapshot(f.sessionId), before);
  f.settle();
  const metrics = f.store.getSnapshot(f.sessionId).timeline.find((i) => i.id === 'answer').detail.metrics;
  assert.deepEqual(metrics, { durationMs: 2000 });
});

test('resume replays prior thread usage under the new turn without charging it again', (t) => {
  const f = fixture(t);
  f.append('turn.metrics.updated', { metrics: { inputTokens: 100, outputTokens: 50 },
    totals: { inputTokens: 100, outputTokens: 50 } }, 'previous-turn');
  f.output('answer', 'message', 'partial');
  f.append('turn.metrics.updated', { metrics: { inputTokens: 100, outputTokens: 50 },
    totals: { inputTokens: 100, outputTokens: 50 } });
  f.time(4000);
  f.settle('turn.interrupted');
  const metrics = f.store.getSnapshot(f.sessionId).timeline.find((i) => i.id === 'answer').detail.metrics;
  assert.deepEqual(metrics, { durationMs: 3000, ttftMs: 0 });
});
