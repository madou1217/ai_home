'use strict';

const crypto = require('node:crypto');

const { buildCodexTimelineItem } = require('../codex-app-server-timeline-item');
const { ChatRuntimeError } = require('./contracts');
const { settleTimelineItem } = require('./timeline-settlement');

const { readPagedTurns, needsPagedTurns, hydrateCodexHistoryResponse,
  requireHistoryThread, requireFullTurn } = require('./codex-history-pages');

async function readCodexSessionHistory(client, threadId, options = {}) {
  const response = await readCodexHistoryResponse(client, threadId, options);
  return projectCodexSessionHistory(response, { ...options, threadId: String(threadId).trim() });
}

async function readCodexHistoryResponse(client, threadId, options = {}) {
  const id = requiredText(threadId, 'codex_history_thread_required');
  if (!client || typeof client.request !== 'function') {
    throw new ChatRuntimeError('codex_history_client_required', 500);
  }
  if (typeof client.ensureConnected === 'function') await client.ensureConnected();
  let response;
  try {
    response = await client.request('thread/read', {
      threadId: id,
      includeTurns: true
    });
  } catch (error) {
    // Paginated Codex threads may reject the legacy full-read
    // request. Read the same durable turns through the versioned list API and
    // feed them into the exact projector used by legacy servers.
    if (!isUnsupportedFullRead(error)) throw error;
    const turns = await readPagedTurns(client, id, options);
    return { thread: { id, turns } };
  }
  return hydrateCodexHistoryResponse(client, response, { ...options, threadId: id });
}

function isUnsupportedFullRead(error) {
  const message = String(error && error.message || '').toLowerCase();
  return error && error.code === 'codex_app_server_rpc_error'
    && (message.includes('list_turns is not supported')
      || message.includes('thread/read') && message.includes('not supported'));
}

function projectCodexSessionHistory(response, options = {}) {
  const thread = requireHistoryThread(response, options.threadId);
  const threadId = thread.id;
  if (!Array.isArray(thread.turns)) {
    throw new ChatRuntimeError('codex_history_turns_invalid', 502);
  }
  const source = {
    provider: 'codex',
    runtimeId: String(options.runtimeId || 'codex:history')
  };
  return {
    threadId,
    revision: numericTimestamp(thread.updatedAt ?? thread.updated_at),
    events: thread.turns.flatMap((turn) => {
      const live = options.readNativeCoverage?.(turn.id) === 'complete'
        ? options.readNativeThreadItems?.(turn.id) : null;
      return projectTurn(threadId, live?.length ? { ...turn, items: live.map((entry) => entry.item) } : turn,
        source, options.recoveryAnchor);
    })
  };
}

function projectTurn(threadId, input, source, recoveryAnchor) {
  const turn = record(input, 'codex_history_turn_invalid');
  requireFullTurn(turn);
  const nativeTurnId = requiredText(turn.id, 'codex_history_turn_invalid');
  const startedAtMs = secondsToMilliseconds(turn.startedAt ?? turn.started_at);
  const completedAtMs = secondsToMilliseconds(turn.completedAt ?? turn.completed_at) || startedAtMs;
  const completed = isTerminalTurn(turn.status);
  return turn.items.map((inputItem) => {
    const nativeItem = record(inputItem, 'codex_history_item_invalid');
    requiredText(nativeItem.id, 'codex_history_item_invalid');
    // thread/read contains persisted message/reasoning items, even during an
    // active turn. Only typed items with an explicit status can still be running.
    const itemCompleted = completed || nativeItem.status !== 'inProgress';
    const projected = buildCodexTimelineItem(
      nativeItem,
      { startedAtMs, completedAtMs, model: optionalText(turn.model) },
      itemCompleted
    );
    const item = {
      ...projected,
      createdAt: startedAtMs,
      ...(itemCompleted ? { updatedAt: completedAtMs } : {})
    };
    const terminalType = turn.status === 'interrupted' ? 'turn.interrupted'
      : turn.status === 'failed' ? 'turn.failed' : 'turn.completed';
    const event = historyEvent(threadId, nativeTurnId,
      completed ? settleTimelineItem(item, terminalType, completedAtMs) : item, source);
    // Only the exact recovered native turn receives the AIH turn identity.
    // Keep the content hash independent of that mapping for import idempotency.
    if (recoveryAnchor?.nativeTurnId === nativeTurnId && recoveryAnchor.turnId) {
      event.turnId = recoveryAnchor.turnId;
      event.payload.item.turnId = recoveryAnchor.turnId;
    }
    return event;
  });
}

function historyEvent(threadId, nativeTurnId, item, source) {
  const terminal = ['completed', 'failed', 'cancelled', 'unknown'].includes(item.status);
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
  readCodexHistoryResponse,
  projectCodexSessionHistory,
  readCodexSessionHistory,
  readPagedTurns,
  needsPagedTurns,
  hydrateCodexHistoryResponse
};
