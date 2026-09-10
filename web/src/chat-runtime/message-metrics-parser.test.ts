import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMessageDetail, parseReasoningDetail } from './timeline-detail-parser';
import { parseActiveTurn } from './snapshot-parser';
import { parseChatRuntimeEvent } from './event-parser';

test('snapshot and live event decoders preserve measured timing and usage including zero', () => {
  const metrics = { durationMs: 5000, ttftMs: 0, inputTokens: 12, outputTokens: 60, tokensPerSec: 12 };
  assert.deepEqual(parseMessageDetail({ role: 'assistant', metrics }).metrics, metrics);
  assert.deepEqual(parseReasoningDetail({ metrics }).metrics, metrics);
  const active = parseActiveTurn({ turnId: 'turn-1', state: 'running', startedAt: 1000, firstTokenAt: 2000, metrics });
  assert.equal(active.firstTokenAt, 2000);
  assert.deepEqual(active.metrics, metrics);
  const event = parseChatRuntimeEvent(JSON.stringify({ schema: 'aih.chat.event.v1', eventId: 'e1', sessionId: 's1',
    seq: 1, at: 2000, type: 'turn.metrics.updated', turnId: 'turn-1',
    source: { provider: 'kimi', runtimeId: 'runtime' }, payload: { metrics } }), 's1');
  assert.deepEqual(event.payload, { metrics });
});

test('missing historical measurements stay absent and malformed numbers fail closed', () => {
  assert.equal(parseMessageDetail({ role: 'assistant' }).metrics, undefined);
  for (const metrics of [{ ttftMs: -1 }, { durationMs: '500' }, { tokensPerSec: Infinity }, { durationMs: 5, ttftMs: 8 }]) {
    assert.throws(() => parseMessageDetail({ role: 'assistant', metrics }), /metrics_invalid/);
  }
});
