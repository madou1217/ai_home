'use strict';

function createAbortError() {
  const error = new Error('operation_aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function subscribeAbort(signal, listener) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  let active = true;
  const onAbort = () => {
    if (!active) return;
    active = false;
    listener(signal.reason);
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    if (!active) return;
    active = false;
    if (typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError();
}

function waitForAbortableDelay(delayMs, context = {}) {
  const schedule = context.setTimeout || setTimeout;
  const cancel = context.clearTimeout || clearTimeout;
  const signal = context.signal;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsubscribe = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) cancel(timer);
      unsubscribe();
      resolve();
    };
    unsubscribe = subscribeAbort(signal, finish);
    if (settled) return;
    timer = schedule(finish, Math.max(0, Number(delayMs) || 0));
  });
}

module.exports = {
  createAbortError,
  subscribeAbort,
  throwIfAborted,
  waitForAbortableDelay
};
