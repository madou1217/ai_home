import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionProjection } from '@/chat-runtime';
import { parseFailedTurn } from '@/chat-runtime/failed-turn-parser';
import { turnFailureMessage, turnProgressText } from './turn-feedback-policy';

const projection: SessionProjection = {
  sessionId: 'session-1', connectionState: 'connected', state: 'running', throughSeq: 1,
  activeTurn: { turnId: 'turn-1', startedAt: 1000, state: 'running' },
  policy: {}, queue: [], interactions: [], items: [], timelineHasMore: false, timelineNextBefore: null,
};

test('waiting feedback advances from the persisted start time and recognizes current-turn output', () => {
  assert.equal(turnProgressText(projection, 6000), '等待响应 · 已用时 5 秒');
  assert.equal(turnProgressText({ ...projection, items: [{
    id: 'answer', turnId: 'turn-1', kind: 'message', status: 'running', createdAt: 3000,
    content: 'answer', detail: { role: 'assistant' },
  }] }, 9000), '生成中 · 已用时 8 秒');
  assert.equal(turnProgressText({ ...projection, state: 'idle', activeTurn: undefined }, 9000), '');
  assert.equal(turnProgressText(projection, 500), '等待响应 · 已用时 0 秒');
});

test('failure DTO validates retryability and retains the original diagnostic', () => {
  const failure = parseFailedTurn({ turnId: 'turn-1', failedAt: 1, retryable: true,
    error: { code: 'auth_invalid_reauth_required', message: 'original diagnostic' } });
  assert.equal(failure.error.message, 'original diagnostic');
  assert.match(turnFailureMessage(failure), /重新登录后重试/);
  assert.throws(() => parseFailedTurn({ ...failure, retryable: 'true' }), /retryable_invalid/);
  assert.throws(() => parseFailedTurn({ ...failure, error: 'not an error object' }), /turn_error_invalid/);
});
