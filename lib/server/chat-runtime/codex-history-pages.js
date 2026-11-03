'use strict';

const { ChatRuntimeError } = require('./contracts');

const DEFAULT_HISTORY_PAGE_LIMIT = 100;
const DEFAULT_MAX_HISTORY_PAGES = 1_000;

// Cursor ownership is part of the protocol: item cursors must never be passed
// to thread/turns/list. Full turn pages also hydrate each turn's complete items.
async function readPagedTurns(client, threadId, options = {}) {
  const turns = [];
  let cursor = options.cursor;
  const sortDirection = options.sortDirection === 'desc' ? 'desc' : 'asc';
  const maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages : DEFAULT_MAX_HISTORY_PAGES;
  const seenCursors = new Set();
  const seenTurns = new Set();
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    if (cursor && seenCursors.has(cursor)) {
      throw new ChatRuntimeError('codex_history_pagination_loop', 502);
    }
    if (cursor) seenCursors.add(cursor);
    const page = await client.request('thread/turns/list', {
      threadId,
      ...(cursor ? { cursor } : {}),
      limit: DEFAULT_HISTORY_PAGE_LIMIT,
      sortDirection,
      itemsView: 'full'
    });
    if (!page || !Array.isArray(page.data)) throw new ChatRuntimeError('codex_history_page_invalid', 502);
    for (const turn of page.data) {
      requireFullTurn(turn);
      if (seenTurns.has(turn.id)) throw new ChatRuntimeError('codex_history_turn_duplicate', 502);
      seenTurns.add(turn.id);
      turns.push(turn);
    }
    cursor = readCursor(page.nextCursor ?? page.next_cursor);
    if (!cursor) return sortDirection === 'desc' ? turns.reverse() : turns;
    // Empty pages can still advance. Only an absent next cursor ends the read.
  }
  throw new ChatRuntimeError('codex_history_pagination_limit', 502, { maxPages });
}

function requireHistoryThread(response, expectedId) {
  if (typeof expectedId !== 'string' || !expectedId.trim()) {
    throw new ChatRuntimeError('codex_history_thread_required', 500);
  }
  const thread = response && response.thread;
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new ChatRuntimeError('codex_history_response_invalid', 502);
  }
  if (thread.id !== expectedId) throw new ChatRuntimeError('codex_history_thread_mismatch', 502, {
    actual: thread.id, expected: expectedId
  });
  return thread;
}

function needsPagedTurns(response) {
  const thread = response && response.thread;
  return !thread || !Array.isArray(thread.turns)
    || Boolean(response.turnsBackwardsCursor || response.turns_backwards_cursor
      || response.itemsBackwardsCursor || response.items_backwards_cursor
      || response.initialTurnsPage || response.initial_turns_page)
    || thread.turns.some(isPartialTurn);
}

async function hydrateCodexHistoryResponse(client, response, options = {}) {
  // Validate before the first RPC, even when the response has no visible turns.
  const thread = requireHistoryThread(response, options.threadId);
  if (!needsPagedTurns(response)) return response;
  const initialPage = response.initialTurnsPage ?? response.initial_turns_page;
  if (initialPage && !Array.isArray(initialPage.data)) {
    throw new ChatRuntimeError('codex_history_page_invalid', 502);
  }
  const existing = thread.turns === undefined ? [] : thread.turns;
  if (!Array.isArray(existing)) throw new ChatRuntimeError('codex_history_turns_invalid', 502);
  const turnCursor = readCursor(response.turnsBackwardsCursor ?? response.turns_backwards_cursor);
  const itemCursor = readCursor(response.itemsBackwardsCursor ?? response.items_backwards_cursor);
  // A backwards turn cursor only covers its anchor and older turns. Summary
  // views (including initialTurnsPage) require a complete read from the start.
  const useBackwards = turnCursor && !itemCursor && !initialPage && !existing.some(isPartialTurn);
  const turns = await readPagedTurns(client, thread.id, {
    ...options,
    cursor: useBackwards ? turnCursor : undefined,
    sortDirection: useBackwards ? 'desc' : 'asc'
  });
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  for (const turn of [...existing, ...(initialPage?.data || [])]) {
    requireTurnIdentity(turn);
    if (byId.has(turn.id)) {
      if (!isPartialTurn(turn)) {
        requireFullTurn(turn);
        const paged = byId.get(turn.id);
        byId.set(turn.id, { ...paged, items: mergeLiveItems(turn.items, paged.items) });
      }
      continue;
    }
    if (isPartialTurn(turn)) throw new ChatRuntimeError('codex_history_incomplete', 502, { nativeTurnId: turn.id });
    requireFullTurn(turn);
    // Preserve full recent turns outside the backwards page stream. Never
    // retain an unhydrated summary as if it were complete history.
    byId.set(turn.id, turn);
  }
  const hydrated = { ...response, thread: { ...thread, turns: [...byId.values()] } };
  for (const key of ['turnsBackwardsCursor', 'turns_backwards_cursor',
    'itemsBackwardsCursor', 'items_backwards_cursor', 'initialTurnsPage', 'initial_turns_page']) {
    delete hydrated[key];
  }
  return hydrated;
}

// A full resume can include a running tool that has not reached the persisted
// page yet. Preserve it at its neighboring item boundary; paged records own
// shared identities. userMessage.clientId correlates temporary resume ids with
// their durable ids without comparing message text or guessing by position.
function mergeLiveItems(live, paged) {
  const pageByKey = new Map(paged.map((item) => [itemKey(item), item]));
  const before = new Map();
  let anchor = null;
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const item = live[index];
    const key = itemKey(item);
    if (pageByKey.has(key)) { anchor = key; continue; }
    if (!before.has(anchor)) before.set(anchor, []);
    before.get(anchor).push(item);
  }
  const merged = paged.flatMap((item) => [...(before.get(itemKey(item)) || []).reverse(), item]);
  return [...merged, ...(before.get(null) || []).reverse()];
}

function itemKey(item) {
  if (!item || typeof item.id !== 'string' || !item.id.trim()) {
    throw new ChatRuntimeError('codex_history_item_invalid', 502);
  }
  return item.type === 'userMessage' && typeof item.clientId === 'string' && item.clientId
    ? `user:${item.clientId}` : `item:${item.id}`;
}

function isPartialTurn(turn) {
  const view = turn && (turn.itemsView ?? turn.items_view);
  return Boolean(view && view !== 'full');
}

function requireFullTurn(turn) {
  requireTurnIdentity(turn);
  if (!Array.isArray(turn.items)) throw new ChatRuntimeError('codex_history_turn_invalid', 502);
  if (isPartialTurn(turn)) throw new ChatRuntimeError('codex_history_incomplete', 502, { nativeTurnId: turn.id });
}

function requireTurnIdentity(turn) {
  if (!turn || typeof turn.id !== 'string' || !turn.id.trim()) {
    throw new ChatRuntimeError('codex_history_turn_invalid', 502);
  }
}

function readCursor(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new ChatRuntimeError('codex_history_page_cursor_invalid', 502);
  return value;
}

module.exports = { readPagedTurns, hydrateCodexHistoryResponse, needsPagedTurns, requireHistoryThread, requireFullTurn };
