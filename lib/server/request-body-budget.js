'use strict';

// Bodies are decoded after buffering. A per-request limit alone still permits
// many concurrent large requests to reserve several GiB.
const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024 * 1024;
let bufferedBytes = 0;
const reservations = new WeakMap();
const closedRequests = new WeakSet();

function getRequestBodyBudgetSnapshot() {
  return {
    bufferedBytes,
    maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
    remainingBytes: Math.max(0, DEFAULT_MAX_BUFFERED_BYTES - bufferedBytes)
  };
}

function reserveRequestBodyBytes(bytes) {
  const amount = Math.max(0, Number(bytes) || 0);
  if (!amount || bufferedBytes + amount > DEFAULT_MAX_BUFFERED_BYTES) return amount === 0;
  bufferedBytes += amount;
  return true;
}

function releaseRequestBodyBytes(bytes) {
  bufferedBytes = Math.max(0, bufferedBytes - Math.max(0, Number(bytes) || 0));
}

function holdRequestBodyBudget(req, bytes) {
  if (!req || typeof req !== 'object') return;
  const amount = Math.max(0, Number(bytes) || 0);
  if (closedRequests.has(req)) {
    releaseRequestBodyBytes(amount);
    return;
  }
  reservations.set(req, (reservations.get(req) || 0) + amount);
}

function releaseRequestBodyBudget(req) {
  if (!req || typeof req !== 'object') return;
  closedRequests.add(req);
  const bytes = reservations.get(req) || 0;
  if (bytes > 0) releaseRequestBodyBytes(bytes);
  reservations.delete(req);
}

module.exports = {
  DEFAULT_MAX_BUFFERED_BYTES,
  getRequestBodyBudgetSnapshot,
  reserveRequestBodyBytes,
  releaseRequestBodyBytes,
  holdRequestBodyBudget,
  releaseRequestBodyBudget
};
