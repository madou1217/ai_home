'use strict';

const DEFAULT_SESSION_MESSAGE_PAGE_LIMIT = 50;
const MAX_SESSION_MESSAGE_PAGE_LIMIT = 50;
const MAX_SESSION_MESSAGE_PAGE_BYTES = 4 * 1024 * 1024;

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_MESSAGE_PAGE_LIMIT;
  }
  return Math.min(parsed, MAX_SESSION_MESSAGE_PAGE_LIMIT);
}

function normalizeBefore(value, total) {
  if (value === null || value === undefined || value === '') return total;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return total;
  return Math.max(0, Math.min(parsed, total));
}

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, 'utf8');
  } catch (_error) {
    return Number.POSITIVE_INFINITY;
  }
}

function findPageStart(messages, end, limit) {
  let start = end;
  let pageBytes = 2; // JSON array brackets.

  while (start > 0 && end - start < limit) {
    const messageBytes = jsonBytes(messages[start - 1]);
    const separatorBytes = start < end ? 1 : 0;
    const exceedsBudget = pageBytes + separatorBytes + messageBytes
      > MAX_SESSION_MESSAGE_PAGE_BYTES;
    if (start < end && exceedsBudget) break;

    start -= 1;
    pageBytes += separatorBytes + messageBytes;
  }

  return start;
}

function readOption(options, name) {
  if (options && typeof options.get === 'function') return options.get(name);
  return options && options[name];
}

function buildSessionMessagePage(messages, options = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const total = allMessages.length;
  const end = normalizeBefore(readOption(options, 'before'), total);
  const limit = normalizeLimit(readOption(options, 'limit'));
  const start = findPageStart(allMessages, end, limit);

  return {
    messages: allMessages.slice(start, end),
    start,
    total,
    hasMore: start > 0
  };
}

module.exports = {
  MAX_SESSION_MESSAGE_PAGE_BYTES,
  buildSessionMessagePage
};
