'use strict';

const crypto = require('node:crypto');

const { buildCodexTimelineItem } = require('../codex-app-server-timeline-item');
const { ChatRuntimeError } = require('./contracts');

async function readCodexSessionHistory(client, threadId, options = {}) {
  const id = requiredText(threadId, 'codex_history_thread_required');
  if (!client || typeof client.request !== 'function') {
    throw new ChatRuntimeError('codex_history_client_required', 500);
  }
  if (typeof client.ensureConnected === 'function') await client.ensureConnected();
  const response = await client.request('thread/read', {
    threadId: id,
    includeTurns: true
  });
  return projectCodexSessionHistory(response, { ...options, threadId: id });
}

function projectCodexSessionHistory(response, options = {}) {
  const expectedId = requiredText(options.threadId, 'codex_history_thread_required');
  const thread = record(response && response.thread, 'codex_history_response_invalid');
  const threadId = requiredText(thread.id, 'codex_history_thread_invalid');
  if (threadId !== expectedId) {
    throw new ChatRuntimeError('codex_history_thread_mismatch', 502, {
      actual: threadId,
      expected: expectedId
    });
  }
  if (!Array.isArray(thread.turns)) {
    throw new ChatRuntimeError('codex_history_turns_invalid', 502);
  }
  const source = {
    provider: 'codex',
    runtimeId: String(options.runtimeId || 'codex:history')
  };
  return {
    threadId,
    revision: numericTimestamp(thread.updatedAt),
    events: thread.turns.flatMap((turn) => projectTurn(threadId, turn, source))
  };
}

function projectTurn(threadId, input, source) {
  const turn = record(input, 'codex_history_turn_invalid');
  const nativeTurnId = requiredText(turn.id, 'codex_history_turn_invalid');
  if (!Array.isArray(turn.items)) {
    throw new ChatRuntimeError('codex_history_turn_invalid', 502, { nativeTurnId });
  }
  const startedAtMs = secondsToMilliseconds(turn.startedAt);
  const completedAtMs = secondsToMilliseconds(turn.completedAt) || startedAtMs;
  const completed = isTerminalTurn(turn.status);
  return turn.items.map((inputItem) => {
    const nativeItem = record(inputItem, 'codex_history_item_invalid');
    requiredText(nativeItem.id, 'codex_history_item_invalid');
    const projected = buildCodexTimelineItem(
      nativeItem,
      { startedAtMs, completedAtMs, model: optionalText(turn.model) },
      completed
    );
    const item = {
      ...projected,
      createdAt: startedAtMs,
      ...(completed ? { updatedAt: completedAtMs } : {})
    };
    return historyEvent(threadId, nativeTurnId, item, source);
  });
}

function historyEvent(threadId, nativeTurnId, item, source) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(item.status);
  const type = terminal ? 'timeline.item.completed' : 'timeline.item.started';
  const identity = stableJson({ threadId, nativeTurnId, type, item });
  return {
    eventId: `history-${crypto.createHash('sha256').update(identity).digest('hex')}`,
    type,
    at: item.createdAt,
    itemId: item.id,
    source: structuredClone(source),
    payload: { item }
  };
}

function isTerminalTurn(value) {
  return ['completed', 'failed', 'interrupted'].includes(String(value || ''));
}

function secondsToMilliseconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const milliseconds = Math.trunc(seconds * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
}

function numericTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatRuntimeError(code, 502);
  }
  return value;
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code, 502);
  return text;
}

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  projectCodexSessionHistory,
  readCodexSessionHistory
};
