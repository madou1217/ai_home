'use strict';

const { ChatRuntimeError } = require('./contracts');
const { requireHistoryThread, requireFullTurn } = require('./codex-history-pages');

// Native fork preserves complete rollout turns, including compaction records.
// Only the selected partial turn needs raw Responses reconstruction. Never
// round a message selection forward to the end of its containing turn.
function planCodexHistoryFork({ response, threadId, itemId, rawTurn, coverage, rawMessageId, excludeMessage = false }) {
  const thread = requireHistoryThread(response, threadId);
  if (!Array.isArray(thread.turns)) throw new ChatRuntimeError('codex_history_turns_invalid', 502);
  const matches = [];
  for (const turn of thread.turns) {
    requireFullTurn(turn);
    for (const [index, item] of turn.items.entries()) {
      if (item.id === itemId) matches.push({ turn, index, item });
    }
  }
  if (matches.length !== 1) throw new ChatRuntimeError('codex_fork_message_identity_unavailable', 409);
  const { turn, index, item } = matches[0];
  if (turn.status !== 'completed') throw new ChatRuntimeError('codex_fork_turn_not_completed', 409);
  if (!['agentMessage', 'userMessage'].includes(item.type)) {
    throw new ChatRuntimeError('codex_fork_message_required', 422);
  }
  if (coverage !== 'complete' || !Array.isArray(rawTurn)) {
    throw new ChatRuntimeError('codex_fork_raw_history_incomplete', 409);
  }
  // User ThreadItem IDs differ from raw user message IDs. Until an explicit
  // mapping is persisted, do not match on text, array position or nearby IDs.
  const rawMatches = rawTurn.flatMap((raw, i) => raw.id === (rawMessageId || itemId) ? [i] : []);
  if (rawMatches.length !== 1) throw new ChatRuntimeError('codex_fork_raw_message_identity_unavailable', 409);
  const cut = rawMatches[0];
  const rawTarget = rawTurn[cut];
  if (rawTarget.type !== 'message' || rawTarget.role !== (item.type === 'agentMessage' ? 'assistant' : 'user')) {
    throw new ChatRuntimeError('codex_fork_raw_message_identity_unavailable', 409);
  }
  const items = rawTurn.slice(0, cut + (excludeMessage ? 0 : 1));
  // Legacy typed history may omit a trailing tool. A visually final message
  // alone cannot prove that a native turn-level fork ends at that message.
  if (!excludeMessage && item.type === 'agentMessage' && index === turn.items.length - 1 && cut === rawTurn.length - 1) {
    return { threadId, lastTurnId: turn.id, items: [], sourceItemId: itemId };
  }
  assertInjectablePrefix(items);
  return { threadId, beforeTurnId: turn.id, items: structuredClone(items), sourceItemId: itemId };
}

function assertInjectablePrefix(items) {
  const ids = new Set();
  const pending = new Map();
  const calls = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
      throw new ChatRuntimeError('codex_fork_raw_item_identity_invalid', 409);
    }
    ids.add(item.id);
    if (['message', 'reasoning'].includes(item.type)) continue;
    const resultType = CALL_OUTPUT.get(item.type);
    if (resultType) {
      if (!item.call_id || calls.has(item.call_id)) throw pairingError(item);
      pending.set(item.call_id, resultType);
      calls.add(item.call_id);
    } else if (OUTPUT_TYPES.has(item.type)) {
      if (!item.call_id || pending.get(item.call_id) !== item.type) throw pairingError(item);
      pending.delete(item.call_id);
    } else {
      throw new ChatRuntimeError('codex_fork_raw_item_unsupported', 422, { itemId: item.id, itemType: item.type });
    }
  }
  if (pending.size) throw new ChatRuntimeError('codex_fork_cut_has_pending_tools', 409);
}

const CALL_OUTPUT = new Map([
  ['function_call', 'function_call_output'],
  ['custom_tool_call', 'custom_tool_call_output']
]);
const OUTPUT_TYPES = new Set(CALL_OUTPUT.values());
function pairingError(item) {
  return new ChatRuntimeError('codex_fork_tool_pair_invalid', 409, { itemId: item.id });
}

module.exports = { planCodexHistoryFork };
