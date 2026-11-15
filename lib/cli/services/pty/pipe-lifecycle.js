'use strict';

// A process can hand off login -> chat without exiting. Keep one observer
// across that handoff and through the final stdout drain, not one per child.
const observers = new WeakMap();

function isOutputBroken(processObj) {
  return observers.get(processObj)?.broken === true;
}

function observeBrokenOutput(processObj, onBroken) {
  let state = observers.get(processObj);
  if (state) {
    state.onBroken = onBroken;
  } else {
    state = { broken: false, onBroken, listeners: [] };
    observers.set(processObj, state);
    for (const stream of [processObj.stdout, processObj.stderr]) {
      if (!stream || typeof stream.on !== 'function') continue;
      const listener = (error) => {
        if (!error || error.code !== 'EPIPE') throw error;
        if (state.broken) return;
        state.broken = true;
        state.onBroken();
      };
      stream.on('error', listener);
      state.listeners.push([stream, listener]);
    }
  }
  return { isBroken: () => state.broken };
}

module.exports = { observeBrokenOutput, isOutputBroken };
