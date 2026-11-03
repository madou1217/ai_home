function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

const MAX_TAIL_BRIDGE_PAGES = 2;

function normalizeSessionHistoryPage(page) {
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const start = normalizeNonNegativeInteger(page?.start);
  const total = Math.max(
    start + messages.length,
    normalizeNonNegativeInteger(page?.total, start + messages.length)
  );
  return {
    messages,
    start,
    total,
    hasMore: start > 0,
    cursor: normalizeNonNegativeInteger(page?.cursor)
  };
}

export function getSessionHistoryWindowEnd(window) {
  const normalized = normalizeSessionHistoryPage(window);
  return normalized.start + normalized.messages.length;
}

function mergeContiguousSessionHistoryWindows(current, incoming, options) {
  const currentEnd = getSessionHistoryWindowEnd(current);
  const incomingEnd = getSessionHistoryWindowEnd(incoming);
  if (incoming.start > currentEnd || incomingEnd < current.start) {
    return null;
  }

  const start = Math.min(current.start, incoming.start);
  const end = Math.max(currentEnd, incomingEnd);
  const messages = new Array(end - start).fill(undefined);

  const writeMessages = (window) => {
    window.messages.forEach((message, index) => {
      messages[window.start - start + index] = message;
    });
  };

  if (options.preferIncoming) {
    writeMessages(current);
    writeMessages(incoming);
  } else {
    writeMessages(incoming);
    writeMessages(current);
  }

  if (messages.some((message) => message === undefined)) return null;
  return {
    messages,
    start,
    total: options.total,
    hasMore: start > 0,
    cursor: options.cursor
  };
}

// Older pages only extend the left side of the latest in-memory window. Their
// total/cursor may come from an older snapshot, so they must never replace or
// advance the already loaded tail.
export function rebaseOlderSessionHistoryPage(latestWindow, olderPage) {
  const older = normalizeSessionHistoryPage(olderPage);
  if (!latestWindow) return older;

  const latest = normalizeSessionHistoryPage(latestWindow);
  const olderEnd = getSessionHistoryWindowEnd(older);
  if (older.start > latest.start || olderEnd < latest.start) return latest;

  return mergeContiguousSessionHistoryWindows(latest, older, {
    preferIncoming: false,
    total: Math.max(latest.total, older.total),
    cursor: latest.cursor
  }) || latest;
}

// Tail snapshots are authoritative for overlapping messages. Rebase them onto
// the latest cached window so a concurrently completed older-page request is
// retained. A lower cursor is a stale tail response and cannot replace newer
// data that completed first.
export function rebaseLatestSessionHistoryTail(latestWindow, refreshedTail) {
  const incoming = normalizeSessionHistoryPage(refreshedTail);
  if (!latestWindow) return incoming;

  const latest = normalizeSessionHistoryPage(latestWindow);
  const incomingIsStale = incoming.cursor < latest.cursor;
  if (!incomingIsStale && incoming.total < latest.total) return incoming;

  const merged = mergeContiguousSessionHistoryWindows(latest, incoming, {
    preferIncoming: !incomingIsStale,
    total: incomingIsStale ? Math.max(latest.total, incoming.total) : incoming.total,
    cursor: incomingIsStale ? latest.cursor : incoming.cursor
  });
  return merged || (incomingIsStale ? latest : incoming);
}

export function advanceSessionHistoryWindow(latestWindow, messages, cursor) {
  if (!latestWindow) return null;
  const latest = normalizeSessionHistoryPage(latestWindow);
  const nextMessages = Array.isArray(messages) ? messages : latest.messages;
  const addedMessages = Math.max(0, nextMessages.length - latest.messages.length);
  return {
    messages: nextMessages,
    start: latest.start,
    total: Math.max(latest.total + addedMessages, latest.start + nextMessages.length),
    hasMore: latest.start > 0,
    cursor: Math.max(latest.cursor, normalizeNonNegativeInteger(cursor))
  };
}

export function isSessionHistorySnapshotCurrent(observedCursor, snapshotWindow) {
  const cursor = normalizeNonNegativeInteger(snapshotWindow?.cursor);
  return cursor >= normalizeNonNegativeInteger(observedCursor);
}

export function didSessionHistoryCursorReset(previousCursor, nextCursor) {
  return normalizeNonNegativeInteger(nextCursor) < normalizeNonNegativeInteger(previousCursor);
}

export function didSessionHistorySnapshotReset(latestWindow, snapshotWindow, observedCursor) {
  if (!latestWindow || !snapshotWindow) return false;
  const latest = normalizeSessionHistoryPage(latestWindow);
  const snapshot = normalizeSessionHistoryPage(snapshotWindow);
  return normalizeNonNegativeInteger(observedCursor) === latest.cursor
    && snapshot.cursor < latest.cursor
    && snapshot.total < latest.total;
}

export async function collectAllSessionHistoryMessages(loadPage) {
  let page = normalizeSessionHistoryPage(await loadPage({}));
  let merged = page;
  const visited = new Set();

  while (page.hasMore && page.start > 0) {
    if (visited.has(page.start)) throw new Error('session_history_page_did_not_advance');
    visited.add(page.start);
    const older = normalizeSessionHistoryPage(await loadPage({ before: page.start }));
    if (older.start >= page.start || getSessionHistoryWindowEnd(older) < page.start) {
      throw new Error('session_history_page_did_not_advance');
    }
    merged = rebaseOlderSessionHistoryPage(merged, older);
    page = older;
  }

  return merged.messages;
}

export async function loadContiguousSessionHistoryTail(currentWindow, loadPage) {
  const current = currentWindow ? normalizeSessionHistoryPage(currentWindow) : null;
  let incoming = normalizeSessionHistoryPage(await loadPage({}));
  if (!current || incoming.total < current.total) return incoming;

  const currentEnd = getSessionHistoryWindowEnd(current);
  const visited = new Set();
  let bridgePageCount = 0;
  while (incoming.start > currentEnd) {
    if (bridgePageCount >= MAX_TAIL_BRIDGE_PAGES) return incoming;
    if (visited.has(incoming.start)) throw new Error('session_history_gap_unresolved');
    visited.add(incoming.start);
    const bridge = normalizeSessionHistoryPage(await loadPage({ before: incoming.start }));
    if (bridge.start >= incoming.start || getSessionHistoryWindowEnd(bridge) < incoming.start) {
      throw new Error('session_history_gap_unresolved');
    }
    incoming = rebaseOlderSessionHistoryPage(incoming, bridge);
    bridgePageCount += 1;
  }

  return rebaseLatestSessionHistoryTail(current, incoming);
}
