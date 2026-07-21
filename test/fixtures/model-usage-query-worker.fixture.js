'use strict';

const { parentPort, threadId } = require('node:worker_threads');

function updateMaximum(counters, value) {
  while (true) {
    const previous = Atomics.load(counters, 1);
    if (previous >= value) return;
    if (Atomics.compareExchange(counters, 1, previous, value) === previous) return;
  }
}

parentPort.on('message', (message = {}) => {
  const query = message.query || {};
  const counters = new Int32Array(query.counters);
  const active = Atomics.add(counters, 0, 1) + 1;
  updateMaximum(counters, active);
  setTimeout(() => {
    Atomics.sub(counters, 0, 1);
    parentPort.postMessage({
      id: message.id,
      ok: true,
      result: { threadId }
    });
  }, Number(query.delayMs) || 0);
});
